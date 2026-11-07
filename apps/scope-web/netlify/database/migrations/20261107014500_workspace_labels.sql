ALTER TABLE scope_app.workspaces ADD COLUMN project_name text NOT NULL DEFAULT 'Commission'
  CHECK (length(project_name) BETWEEN 1 AND 120);
CREATE INDEX invitations_recipient_email ON scope_app.invitations(recipient_email);
