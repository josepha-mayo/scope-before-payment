CREATE ROLE scope_portable_actor_enroller NOLOGIN;
GRANT INSERT(provider,provider_subject,actor_id,created_via) ON scope_identity.actor_links TO scope_portable_actor_enroller;
