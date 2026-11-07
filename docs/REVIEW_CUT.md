# Record an owned review cut

The `Owned review cut` GitHub Actions workflow records the current frontend,
HTTP API and actual PostgreSQL in an isolated fixture. The approximately
158-second WebM is a review artifact. Every scene carries an explicit label:
authored identities, AI replay and PayPal responses; no real transaction.
It is not the final required public YouTube demonstration or a Devpost entry.

The script creates a fresh invented Aster Studio workspace, replays observed
suggestion text through the actual validation/review UI, publishes an exact
offer, records a buyer change request, publishes a linked response at a new
amount, separately accepts revision2 and exercises one authored checkout.
A deliberately lost capture reply recovers through a saved-status GET with
exactly one capture. A readable record is downloaded. No external browser
request is permitted, no live inference or PayPal call is sent, and no hosting
deployment is made. The real [live AI example](LIVE_AI_QUALIFICATION.md) remains
separate evidence; the replay is not the original provider response bytes.

Run the workflow manually from Actions. Changes to its recording files also
run it on pull requests. It provisions a disposable PostgreSQL17 service and
refuses an existing application schema or user tables. The loopback database,
CI flags and known fixture user must match before migrations run. The test-only
provider callback is in the isolated browser fixture, outside production dist.

Download the `owned-review-cut` artifact. Inspect `receipt.json` first: only a
passed recording, matching source tree and video digest is usable. The artifact
also contains chapter narration and the authored readable record. Failed or
partial recordings are debugging evidence and must not be presented as success.
Artifacts expire after14days; preserve any chosen review cut locally.

On Windows, with Node-independent FFmpeg/ffprobe and an installed English system
voice, render a narrated MP4 into a new directory:

```powershell
powershell.exe -NoProfile -File tools/render-review-cut.ps1 -InputDirectory C:\path\to\artifact -OutputDirectory C:\path\to\new-review-cut
```

The script verifies the WebM digest and a duration under180seconds, synthesizes
chapter narration with the installed voice, checks each speech segment fits,
encodes H.264/AAC and writes a render receipt. `-NoNarration` produces a captioned
silent cut instead. It preserves existing directories and never uploads files.
System speech is synthetic narration, not a recording or clone of the creator.

Before publishing a final demo, replace authored provider/person evidence with
the legitimately qualified real sandbox and buyer flow, verify the public links
and review every factual claim. Source-only features shown in this cut must be
distinguished from the older hosted release while its credit hold remains.
