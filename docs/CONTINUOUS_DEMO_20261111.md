# Continuous browser demo — November 11

[Watch the corrected 2:32 demo](https://www.youtube.com/watch?v=VlsOWv2Rct0).
The existing [Devpost project](https://devpost.com/software/scope-before-payment)
and PayPal AI Hackathon entry both use this video. It replaces the November 10
video, which relied on still-image layouts and did not satisfy the organizer's
request for footage of the application functioning on its target device.

## What the footage demonstrates

| Time | Footage and evidence boundary |
| --- | --- |
| 00:00 | Hosted application: invented Fern subtitle conversation beside an exact offer. |
| 00:14 | Saved real NVIDIA review: opening a suggestion and its original source excerpts. No new inference is claimed. |
| 00:32 | Human correction: adding exclusions that the model missed. |
| 00:40 | Hosted application: confirming a reviewed suggestion, copying it into the explicitly cleared field, clarifying deliverables, confirming all six fields, and saving revision 2 at USD48. The buyer has not accepted this revision. |
| 01:09 | Separately labeled local rehearsal: an authored buyer requests 300 postcards; the creator publishes USD210 revision 2; the buyer compares changes and explicitly accepts that version. Actual UI, HTTP and PostgreSQL are exercised with authored accounts and provider replies. No external provider request occurs. |
| 01:48 | Hosted Willow qualification: reading the saved successful November 10 USD5 PayPal Sandbox capture, signed approval/capture notifications and original create/check/capture journal. This recording does not repeat the payment. |
| 02:22 | Hosted Willow qualification: preparing a readable record of the accepted agreement. |

The hosted footage consists of continuous browser-pixel captures during real
keyboard navigation, field edits, review and publication. The capture rate is
approximately 6–8 frames per second; the encoded video is 30 fps. Chapter cuts
join the takes. The UI is not recreated, animated from mockups or replaced with
presentation cards. The rehearsal uses a retained continuous recording from the
actual local application. Its old overlay is cropped out and replaced with a
persistent, explicit rehearsal label.

Joseph's own voice is cloned locally with his permission. Source voice recordings
are not uploaded or included in the video. AI use is disclosed on YouTube. Timed
English captions are burned into a dedicated margin beneath the app footage, so
they do not cover controls. There is no music.

## Verification

- Final media: H.264/AAC, 1920×1080, 152.321 seconds; full decode passed.
- Final MP4 SHA-256: `eca9dbd91b325e09c19e8e42a982b16bf60a05db53e67b91a9fc5aa05d9a7677`.
- Caption cues do not overlap. Local speech readback covers 95.9–100% of the
  reviewed script tokens. This is not a human voice-similarity assessment.
- YouTube reports no copyright issues; public playback and anonymous embedding
  were verified. The channel is Joseph Ayanda. Subscriber notifications and
  remixing are disabled.
- A read-only database check after recording still found exactly three provider
  calls: one create, one check and one completed capture; two matching signed
  events and zero conflicts. The inspector made no PayPal requests.
- Devpost's existing entry remains Submitted with all five steps complete. Both
  its video field and the public project embed were read back in Brave. The old
  Netlify project link was replaced by the working Render host.

See [real sandbox evidence](REAL_PAYPAL_SANDBOX_20261110.md) and
[local rehearsal setup](LOCAL_REHEARSAL.md). This is a qualified sandbox
prototype. It does not establish general production readiness, live-money
onboarding, independent user testing, or organizer acceptance of the correction.
