# Record an owned review cut

## Current published demo — November 10

[Watch the 2:39 real PayPal Sandbox demo](https://www.youtube.com/watch?v=iMB-rgryzy4).
The 1920×1080 H.264/AAC edit is 159.033 seconds and has 45 non-overlapping,
timed English captions. [Download the caption file](demo/scope-paypal-sandbox-20261110.en.srt).
SHA256 `879b09062202fcc625ffe6f97e22e058e91a5f6eab4294d26472e2b8a979112a`.

The first half shows real hosted NVIDIA review and exact USD48 publication.
The change-request scene is a labeled local rehearsal. The second half uses
actual hosted screenshots and the [verified USD5 sandbox journal](REAL_PAYPAL_SANDBOX_20261110.md)
for buyer acceptance, one create/check/capture, registered signed notifications,
and the saved result after reload. These are separate invented commissions.

Joseph's consented own-voice clone was generated locally with Chatterbox Nano;
original recordings were not uploaded. YouTube's AI disclosure is enabled.
No music or real-money payment is included. The prototype's live onboarding,
independent usability and production recovery limits are disclosed.

The videos below are historical edits. Their deployment and payment status
statements describe the corresponding recording date.

## Revised published demo — November 9 archive

[Watch the revised 2:32 prototype](https://www.youtube.com/watch?v=89WKFiUpklM).
The existing Devpost entry used this replacement at the time. The original
November 8 video remains an archive.

The revised cut uses Joseph's own voice, cloned locally with his explicit consent
from his recording using Chatterbox Nano. The model's built-in watermark remains;
the original recordings, reference audio and local runtime are private. It has
focused, readable UI views, dated provider evidence, burned captions and an
uploaded English caption track. No music is used. The edited MP4 is 1920×1080,
H.264/AAC, 152.033 seconds; SHA256:
`eedca1d69c5696700859bc9599a954714b35019a56d257be6caf6a0e80c82959`.
The reviewed captions are retained in [the English SRT](demo/scope-demo-20261109.en.srt).

The actual UI/API/PostgreSQL recording ran at commit
`afdc7e8e68526a6e2d068d841924080584d3b2f2`, tree
`1f9b4945749bf1d78e32d9fa2103409dd49e24ee`, in
[owned recording run 42593201154](https://github.com/josepha-mayo/scope-before-payment/actions/runs/42593201154).
Only the recorder differs from application main `81f7aee`: the application code
is identical. The new overview and visual improvements passed all four checks
on [that main](https://github.com/josepha-mayo/scope-before-payment/actions/runs/42591951280).
The recording retains focused screenshots with hashes and uses one authored
create/check/capture sequence, saved-status recovery and zero external requests.

The retained real Claude result was generated November 7 and its citations were
read again November 9 without new inference. The original PayPal response from
November 5 was read November 8 and shows an earlier USD120 order awaiting payer
action. It is not capture, a current-status query or payment for the authored
USD210 example. Authored accounts, AI replay and PayPal responses stay visibly
labeled. Real capture, registered signed delivery and independent buyer
qualification remain unfinished. The hosted release remains older than this
source while credits are conserved; hosted checkout is inactive.

## Original published prototype edit — archive

[Watch the public narrated prototype](https://www.youtube.com/watch?v=3WPUbg7cLTg)
(2:53), published November 8, 2026. It combines the owned workflow below with
separate dated screenshots: a retained live Claude review on invented text
(November 7) and PayPal's saved response for an earlier USD120 sandbox order
(November 5, inspected November 8). That response was awaiting payer action;
it is not a capture, current-status query or payment for the authored USD210
commission. The workflow's authored identities, AI replay and PayPal replies
remain visibly labeled. Real capture, registered signed delivery and independent
buyer qualification remain unfinished.

The edit uses the recording tree `b7fb759ba17bf7f723f7dc3e4d4f12d0734c1e50`
from main `c5de092`, with synthetic system narration and no music or cloned voice.
Its MP4 SHA256 is
`5d22e694213c720cfb5f9883276e2dadade1106998f3aae5750abff745947e98`.
Later documentation/CI-only changes are not a new application execution. The
public video is not evidence that a Devpost entry exists or production gates
have passed.

## Reproduce the raw workflow recording

The `Owned review cut` GitHub Actions workflow records the current frontend,
HTTP API and actual PostgreSQL in an isolated fixture. The approximately
158-second WebM is a review artifact. Every scene carries an explicit label:
authored identities, AI replay and PayPal responses; no real transaction.
It is not the final required public YouTube demonstration or a Devpost entry.

The payment chapter holds the created order, checked approval, lost reply and
recovered record on screen separately. Its receipt records three payment views
with timestamps and full-viewport assertions; phase screenshots are retained.
Inspect rendered frames as well as passing action counts before using the cut.

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
