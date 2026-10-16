-- Senior competitions publish lineups on the public pages; youth competitions never do.
-- Existing competitions with a youth age group (U17, P14, F12 ...) are not senior.
alter table competitions add column is_senior boolean not null default true;
update competitions set is_senior = false where age_group ~* '^\s*[upfgb]\s*-?\d';
