-- One account per email regardless of letter case: emails are stored lowercased, and this keeps a differently-cased
-- duplicate from registering beside an existing account (the subscription allow-list and admin emails compare lowercase).
-- Lowercase existing rows first; this fails, and must be resolved by hand, if two accounts differ only by case.
UPDATE users SET email = lower(email) WHERE email <> lower(email);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
