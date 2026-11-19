-- Teams own boards. A team is a group of people ({id, name, color, capacity}
-- each) that cards on any of its boards are assigned to, so its workload
-- covers all its boards. Until now each board had its own team in
-- boards.team.
create table kanban.teams (
  id text primary key,
  owner_id uuid not null references kanban.users (id) on delete cascade,
  name text not null,
  members jsonb not null default '[]'::jsonb,
  created_at bigint not null,
  updated_at timestamptz not null default clock_timestamp()
);
create index teams_owner_id_idx on kanban.teams (owner_id);

alter table kanban.boards add column team_id text references kanban.teams (id) on delete set null;
create index boards_team_id_idx on kanban.boards (team_id);

create trigger teams_touch_row before update on kanban.teams
  for each row execute function kanban.touch_board_row();

-- Live updates: everyone who can see the team hears about changes to it. When
-- it is deleted, its boards still point at it here (before the delete), so the
-- people to tell are listed in the event.
create function kanban.notify_team() returns trigger language plpgsql as $$
declare
  r record;
  people json;
begin
  if tg_op = 'DELETE' then
    r := old;
    select coalesce(json_agg(distinct m.user_id), '[]'::json) into people
    from kanban.board_members m join kanban.boards b on b.id = m.board_id
    where b.team_id = old.id;
    perform pg_notify(
      'kanban_events',
      json_build_object('type', 'team', 'teamId', r.id, 'userIds', people, 'ownerId', r.owner_id)::text
    );
    return old;
  end if;
  perform pg_notify('kanban_events', json_build_object('type', 'team', 'teamId', new.id)::text);
  return null;
end;
$$;

create trigger teams_notify after insert or update on kanban.teams
  for each row execute function kanban.notify_team();
create trigger teams_notify_delete before delete on kanban.teams
  for each row execute function kanban.notify_team();

-- Each owner's board teams become one team, so nobody loses anyone: people
-- with the same name (ignoring case) on several boards become one person, who
-- keeps the id and color first seen and the largest capacity. Cards and
-- assignments waiting for approval follow them to their kept id. Boards
-- without a team stay without one. boards.team is left as it was, but is no
-- longer read.
do $$
declare
  o record;
  b record;
  m jsonb;
  tid text;
  people jsonb;
  ids jsonb;
  kept jsonb;
  new_id text;
begin
  for o in
    select distinct bo.owner_id, u.email
    from kanban.boards bo join kanban.users u on u.id = bo.owner_id
    where jsonb_array_length(bo.team) > 0
  loop
    tid := gen_random_uuid()::text;
    people := '[]'::jsonb;
    insert into kanban.teams (id, owner_id, name, created_at)
    values (tid, o.owner_id, split_part(o.email, '@', 1) || '''s team',
      (extract(epoch from now()) * 1000)::bigint);

    for b in
      select id, team from kanban.boards
      where owner_id = o.owner_id and jsonb_array_length(team) > 0
      order by created_at, id
    loop
      ids := '{}'::jsonb; -- this board's member id -> the team's member id
      for m in select value from jsonb_array_elements(b.team) loop
        select x into kept from jsonb_array_elements(people) x
        where lower(btrim(x->>'name')) = lower(btrim(m->>'name')) limit 1;
        if kept is null then
          new_id := m->>'id';
          if exists (select 1 from jsonb_array_elements(people) x where x->>'id' = new_id) then
            new_id := new_id || '-' || jsonb_array_length(people);
          end if;
          people := people || jsonb_build_array(jsonb_set(m, '{id}', to_jsonb(new_id)));
        else
          new_id := kept->>'id';
          if coalesce((m->>'capacity')::int, 0) > coalesce((kept->>'capacity')::int, 0) then
            people := (
              select jsonb_agg(case when x->>'id' = new_id then jsonb_set(x, '{capacity}', m->'capacity') else x end
                order by i)
              from jsonb_array_elements(people) with ordinality p(x, i)
            );
          end if;
        end if;
        ids := ids || jsonb_build_object(m->>'id', new_id);
      end loop;

      update kanban.cards c set assignee_ids = (
        select coalesce(jsonb_agg(v order by first), '[]'::jsonb)
        from (
          select coalesce(ids->>a, a) as v, min(i) as first
          from jsonb_array_elements_text(c.assignee_ids) with ordinality t(a, i)
          group by 1
        ) mapped
      )
      where c.board_id = b.id and jsonb_array_length(c.assignee_ids) > 0;

      update kanban.assignment_requests r set assignees = (
        select coalesce(jsonb_agg(
          case when p->>'id' is not null and ids ? (p->>'id') then jsonb_set(p, '{id}', ids->(p->>'id')) else p end
          order by i), '[]'::jsonb)
        from jsonb_array_elements(r.assignees) with ordinality q(p, i)
      )
      where r.board_id = b.id and jsonb_array_length(r.assignees) > 0;

      update kanban.boards set team_id = tid where id = b.id;
    end loop;

    update kanban.teams set members = people where id = tid;
  end loop;
end;
$$;
