-- ==============================================================
-- app-gate · the PIN throttle   (also section 10 of supabase/schema.sql)
--
-- Safe to re-run: every statement is create-if-not-exists or
-- create-or-replace. This file does NOT touch any anon policy -- the lock
-- is a separate, later step (supabase/app-gate-lock.sql) that must only
-- run once the PIN-gated index.html is live. See CLAUDE.md, "The PIN gate".
--
-- One row per caller IP that has presented a wrong PIN recently.
--
-- WHY IT COUNTS DISTINCT WRONG PINS, NOT WRONG REQUESTS
--
-- The reference design counted every wrong request. On this app that locks
-- the whole desk out: the schedulers share one office IP, and the moment the
-- owner changes APP_PIN every open tab fails several requests at once (the
-- poll, availability, notes, the profile read). Two tabs are past 8 within a
-- second, and then the person typing the NEW PIN is refused for fifteen
-- minutes too. A stale tab repeating the old PIN is not a guess; a
-- brute-forcer has to try different values. So `keys` holds an HMAC of each
-- distinct wrong PIN in the window and `fails` is how many there are. The
-- HMAC is keyed with a server secret, so a stored key says nothing about the
-- PIN it came from.
--
-- WHY THE WHOLE DECISION IS ONE SQL CALL
--
-- An earlier version read the lock first and recorded a failure afterwards,
-- as two calls. A burst of simultaneous guesses then all passed the read
-- before the 8th failure landed, and every one of them had its PIN compared
-- - the limit held for requests in sequence and not at all for a burst.
-- gate_check() takes the IP's row lock, so every verdict for one IP is
-- decided in turn: once 8 distinct wrong PINs are recorded, nothing after
-- them - right PIN or wrong - gets an answer but "locked".
-- ==============================================================
create table if not exists public.auth_throttle (
  ip           text        primary key,
  fails        int         not null default 0,
  first_fail   timestamptz not null default now(),
  locked_until timestamptz,
  keys         text[]      not null default '{}'
);
alter table public.auth_throttle add column if not exists keys text[] not null default '{}';

-- No anon access of any kind. Only app-gate, with the service key.
alter table public.auth_throttle enable row level security;
revoke all on public.auth_throttle from anon, authenticated;
comment on table public.auth_throttle is
  'RLS on with NO policies on purpose: only the service role reaches this. Written by the app-gate edge function to throttle wrong PINs per IP.';

-- The verdict for one request from p_ip.
--   p_key      HMAC of the PIN it carried (hex)
--   p_ok       whether that PIN was right (compared in the function)
--   p_max      distinct wrong PINs allowed per window; the p_max-th locks
--   p_window_s the counting window, in seconds
--   p_lock_s   how long a lock lasts, in seconds
-- Returns verdict 'ok' | 'bad' | 'locked', the distinct wrong PINs in the
-- current window, and the lock expiry when locked.
create or replace function public.gate_check(p_ip text, p_key text, p_ok boolean,
                                             p_max int, p_window_s int, p_lock_s int)
returns table (verdict text, fails int, locked_until timestamptz)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  r      public.auth_throttle%rowtype;
  now_ts timestamptz := now();
  stale  boolean;
begin
  -- A right PIN from an IP with no recent failures is the common case (every
  -- poll): one indexed read, no write, no lock held.
  select * into r from public.auth_throttle where ip = p_ip for update;
  if not found and p_ok then
    return query select 'ok'::text, 0, null::timestamptz;
    return;
  end if;
  if not found then
    insert into public.auth_throttle (ip, fails, first_fail, locked_until, keys)
    values (p_ip, 0, now_ts, null, '{}')
    on conflict (ip) do nothing;
    select * into r from public.auth_throttle where ip = p_ip for update;
  end if;

  -- Locked: nobody from this IP gets any other answer, not even a right PIN.
  if r.locked_until is not null and r.locked_until > now_ts then
    return query select 'locked'::text, r.fails, r.locked_until;
    return;
  end if;

  -- The window has passed, or a lock has expired: the count starts again.
  stale := r.locked_until is not null or now_ts - r.first_fail > make_interval(secs => p_window_s);
  if stale then
    r.keys := '{}';
    r.first_fail := now_ts;
    r.locked_until := null;
  end if;

  if p_ok then
    -- Earlier failures are NOT cleared by a right PIN: the desk polls from one
    -- office IP every 20 seconds, so clearing would reset the count for
    -- anybody else on that network three times a minute.
    if stale then
      update public.auth_throttle set fails = 0, first_fail = r.first_fail, locked_until = null, keys = '{}'
       where ip = p_ip;
    end if;
    return query select 'ok'::text, coalesce(array_length(r.keys, 1), 0), null::timestamptz;
    return;
  end if;

  if not (p_key = any (r.keys)) then
    r.keys := r.keys || p_key;
  end if;
  r.fails := coalesce(array_length(r.keys, 1), 0);
  if r.fails >= p_max then
    r.locked_until := now_ts + make_interval(secs => p_lock_s);
  end if;
  update public.auth_throttle
     set fails = r.fails, first_fail = r.first_fail, locked_until = r.locked_until, keys = r.keys
   where ip = p_ip;
  return query select 'bad'::text, r.fails, r.locked_until;
end
$$;

-- SECURITY DEFINER, so nobody but the service role may call it.
revoke all on function public.gate_check(text, text, boolean, int, int, int) from public, anon, authenticated;
grant execute on function public.gate_check(text, text, boolean, int, int, int) to service_role;

-- Replaced by gate_check (it recorded a failure after a separate lock read,
-- which a burst could outrun). Nothing else ever called it.
drop function if exists public.gate_fail(text, text, int, int, int);

notify pgrst, 'reload schema';
