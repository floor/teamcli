import { hostedCommit } from '../host/request-scope.ts';
// The one network seam of `team release check`: a URL in, one HTTP attempt out. Every read the
// command makes but one is public and credential-free — for those this wiring sends no header of
// any kind. The single exception is the Linear read's POST, whose caller names the headers
// exactly (its media type and its one credential); the wiring adds nothing of its own in either
// case. It follows no redirect (a 3xx is the answer, and the checks read it as unknown), never
// reads a credential or a credential helper, and never touches git. The retry policy and the
// read/attempt caps live with the checks (src/release/checks.ts); here is only one attempt, with
// its timeout and its size limit.

/** One HTTP attempt: the status and the decoded, size-limited body, or why no response was read.
 *  Every kind that comes from a response carries its status — `http`, `too-large` (a body over
 *  the limit; it also carries `prefix`, the decoded head of that body, because a value a read
 *  needs can sit near a document's head while the bulk of the body never is) and `undecodable`
 *  (a body that is not valid UTF-8, never repaired into a replacement character) — so the retry
 *  rule reads the status whatever the body; `timeout` and `transport` are the kinds with no
 *  response at all. */
export type Attempt =
  | { kind: 'http'; status: number; body: string }
  | { kind: 'timeout' }
  | { kind: 'transport' }
  | { kind: 'too-large'; status: number; prefix: string }
  | { kind: 'undecodable'; status: number };

/** The one request shape beyond a bare GET: the Linear read's POST. Its headers are exactly what
 *  the caller names — the wiring adds nothing, so a credential can never travel anywhere else. */
export type RequestOptions = { method: 'POST'; headers: Record<string, string>; body: string };

export type Fetch = (url: string, request?: RequestOptions) => Promise<Attempt>;

/** Each attempt times out after this, the body read included. */
export const TIMEOUT_MS = 5000;

/** The response-body limit, measured after content decoding. */
export const BODY_LIMIT = 1024 * 1024;

function why(error: unknown): Attempt {
  return { kind: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'transport' };
}

/** The decoded head of an over-limit body: the chunks read, in order, with no final flush — a
 *  character split at the cut is dropped, never repaired. The head is a prefix, not a document. */
function headOf(chunks: Uint8Array[]): string {
  const decoder = new TextDecoder('utf-8');
  let out = '';
  for (const chunk of chunks) out += decoder.decode(chunk, { stream: true });
  return out;
}

/** Node's `fetch` as the command's network: HTTPS, no headers of its own, no redirects followed. */
export const realFetch: Fetch = async (url, request) => {
  try {
    hostedCommit('fetch');
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(request ? { method: request.method, headers: request.headers, body: request.body } : {}),
    });
    // The limit is on the decoded body: undici applies the content encoding as the body streams.
    const body = response.body;
    if (body === null) return { kind: 'http', status: response.status, body: '' };
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) {
        // Over the limit: keep the body's decoded head, exactly up to the limit — the byte that
        // crossed it and the rest of the body are not read.
        chunks.push(value.subarray(0, BODY_LIMIT - (size - value.byteLength)));
        await reader.cancel();
        return { kind: 'too-large', status: response.status, prefix: headOf(chunks) };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    // Fatal: a response that is not valid UTF-8 is not repaired into U+FFFD and read anyway.
    let bodyText: string;
    try {
      bodyText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { kind: 'undecodable', status: response.status };
    }
    return { kind: 'http', status: response.status, body: bodyText };
  } catch (error) {
    return why(error);
  }
};
