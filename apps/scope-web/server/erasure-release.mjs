// The complete pause/consent/claim/redaction/recovery flow and its production
// ledger must be qualified before this becomes true. Privacy routes remain
// unavailable while false; metadata alone cannot establish content erasure.
export const workspaceContentErasureEnabled=false;
// Qualify before first erasure release. Once enabled, keep the read fence on
// even when pausing new erasure actions; old intents must remain authoritative.
export const workspaceContentReadFenceEnabled=false;
