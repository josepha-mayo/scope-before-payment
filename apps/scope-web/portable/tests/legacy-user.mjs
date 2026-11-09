// Explicit authored legacy fixture, not an HTTP registration endpoint. A
// context-free testUtils.saveUser cannot run the SDK's OAuth validation gate.
// Keep that gate intact and seed the owned DB before issuing test SDK sessions.
export async function insertLegacyUser(pool,user){
  await pool.query('INSERT INTO scope_identity.users(id,name,email,email_verified,image,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[user.id,user.name,user.email,user.emailVerified,user.image,user.createdAt,user.updatedAt]);
  return user;
}
