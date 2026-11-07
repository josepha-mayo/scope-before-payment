// During an approved incident, commit true and deploy this reviewed release
// BEFORE restoring data. This compiled hold survives missing runtime env vars.
// Clearing it is a separate reviewed code/deploy decision after reconciliation.
export const recoveryReadOnly=false;
