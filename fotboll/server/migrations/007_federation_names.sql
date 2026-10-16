-- The federation's name in each language, like competitions.name_i18n.
-- `name` stays the main name and the fallback.
alter table federations add column name_i18n jsonb;
