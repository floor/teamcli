# team ask-show

Prints the question from a signed ask when the marker's HMAC matches that question and the
request id, and `expires_at` is not yet past. The same 5 seconds of clock skew the guard
allows still counts as in time. A marker that does not verify, or an ask that has expired,
prints no question.

## Synopsis

    team ask-show <request_id> --ask <path> --marker <path> --key <path> [--json]

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--ask` | `<path>` | the signed ask file |
| `--marker` | `<path>` | the marker file |
| `--key` | `<path>` | the marker key, base64url of 32 bytes |
| `--json` | — | one document (`format: 1`, registered as `schema/ask-show.schema.json`) instead of the text: the request id, the question, the marker's `expires_at`, and `verified: true` |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| anyone who can read the key file | run it; there is no team-file check, no seat check, and no herdr call |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the marker matches, and `expires_at` plus 5 seconds is still ahead | the question, then the summary line `request <request_id> verified, expires <expires_at>`, on stdout | 0 |
| the ask is past `expires_at` plus 5 seconds | one `team ask-show: the ask has expired` line, on stderr; no question | 1 |
| the marker does not verify, or a file cannot be read | one `team ask-show: …` line, on stderr; no question | 1 |
| the invocation cannot be read | `team ask-show: …` and the usage | 2 |

The question is the reading; the summary line that closes it names the request the marker verified
and its deadline. Under `--json` the same reading is one document (`team.ask-show`), and a refusal
is the structured error document (`team.error`, its `error.id` the contract row), with stderr empty.

## Example

```file file=key.txt
QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI
```

```file file=ask.txt
TeamCLI signed ask v1
{"question":"Status?","request_id":"req-ask-show-v1"}
```

```file file=marker.json
{"v":1,"request_id":"req-ask-show-v1","question_sha256":"7fa2d11897a567998b667f4b453ac20b68a6813fde68222e583f90a5bf453b96","expires_at":"2026-10-12T18:00:00.000Z","mac":"8d53d07c074d438d6676e20b45b11ea021b54e30d36d840b48e4f7a41223cbce"}
```

```console
$ team ask-show req-ask-show-v1 --ask ask.txt --marker marker.json --key key.txt ; echo "exit $?"
Status?
request req-ask-show-v1 verified, expires 2026-10-12T18:00:00.000Z
exit 0
```
