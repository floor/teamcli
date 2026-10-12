# team ask-show

Prints the question from a signed ask when the marker's HMAC matches that question and the
request id. A marker that does not verify prints no question.

## Synopsis

    team ask-show <request_id> --ask <path> --marker <path> --key <path>

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--ask` | `<path>` | the signed ask file |
| `--marker` | `<path>` | the marker file |
| `--key` | `<path>` | the marker key, base64url of 32 bytes |
| `--help`, `-h` | — | the usage, and exit 0 |

## Who may run it

| Caller | May |
| --- | --- |
| anyone who can read the key file | run it; there is no team-file check, no seat check, and no herdr call |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| the marker matches | the question, on stdout | 0 |
| the marker does not verify, or a file cannot be read | one `team ask-show: …` line, on stderr; no question | 1 |
| the invocation cannot be read | `team ask-show: …` and the usage | 2 |

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
exit 0
```
