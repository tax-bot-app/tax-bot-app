begin;

update public.users
set monthly_quota = 0
where plan = 'free'
  and monthly_quota is distinct from 0;

update public.usage as usage
set limit_talks = 0
from public.users as users
where users.id = usage.user_id
  and users.plan = 'free'
  and usage.limit_talks is distinct from 0;

commit;
