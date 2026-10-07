-- Personal API tokens are called API keys now.
alter table kanban.api_tokens rename to api_keys;
alter index kanban.api_tokens_user_id_idx rename to api_keys_user_id_idx;
