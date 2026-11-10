-- 联机大厅所需的四张表：房间、房内成员、动作日志
-- 设计前提：纯静态站点没有自己的服务端，所以"实时"靠云库轮询，
-- 且所有写入都必须落在"自己的行"上，不能改别人的行（RLS 只允许 owner_id = auth.uid()）。

DO $$
BEGIN
  /* ---------------- 房间 ---------------- */
  CREATE TABLE IF NOT EXISTS public.mahjong_rooms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id text NOT NULL DEFAULT auth.uid(),
    seed bigint NOT NULL,
    hall_id text NOT NULL DEFAULT 'novice',
    base_bet integer NOT NULL DEFAULT 2000,
    status text NOT NULL DEFAULT 'waiting',      -- waiting | playing | done
    human_count integer NOT NULL DEFAULT 0,      -- 开局时由房主定稿，之后所有人按这个数排座
    target_seats integer NOT NULL DEFAULT 4,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE public.mahjong_rooms ENABLE ROW LEVEL SECURITY;
  GRANT SELECT, INSERT, UPDATE ON public.mahjong_rooms TO authenticated;

  DROP POLICY IF EXISTS mahjong_rooms_read ON public.mahjong_rooms;
  CREATE POLICY mahjong_rooms_read ON public.mahjong_rooms
    FOR SELECT TO authenticated USING (true);

  DROP POLICY IF EXISTS mahjong_rooms_insert ON public.mahjong_rooms;
  CREATE POLICY mahjong_rooms_insert ON public.mahjong_rooms
    FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());

  DROP POLICY IF EXISTS mahjong_rooms_update ON public.mahjong_rooms;
  CREATE POLICY mahjong_rooms_update ON public.mahjong_rooms
    FOR UPDATE TO authenticated
    USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

  /* ---------------- 房内成员（同时也是匹配队列） ---------------- */
  CREATE TABLE IF NOT EXISTS public.mahjong_room_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id uuid NOT NULL REFERENCES public.mahjong_rooms(id) ON DELETE CASCADE,
    owner_id text NOT NULL DEFAULT auth.uid(),
    name text NOT NULL DEFAULT '牌友',
    as_ai boolean NOT NULL DEFAULT false,
    joined_at timestamptz NOT NULL DEFAULT now(),
    last_seen timestamptz NOT NULL DEFAULT now(),
    UNIQUE (room_id, owner_id)
  );
  ALTER TABLE public.mahjong_room_members ENABLE ROW LEVEL SECURITY;
  GRANT SELECT, INSERT, UPDATE ON public.mahjong_room_members TO authenticated;

  DROP POLICY IF EXISTS mahjong_members_read ON public.mahjong_room_members;
  CREATE POLICY mahjong_members_read ON public.mahjong_room_members
    FOR SELECT TO authenticated USING (true);

  DROP POLICY IF EXISTS mahjong_members_insert ON public.mahjong_room_members;
  CREATE POLICY mahjong_members_insert ON public.mahjong_room_members
    FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());

  DROP POLICY IF EXISTS mahjong_members_update ON public.mahjong_room_members;
  CREATE POLICY mahjong_members_update ON public.mahjong_room_members
    FOR UPDATE TO authenticated
    USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

  /* ---------------- 动作日志：谁打了哪张牌，一行一条 ---------------- */
  CREATE TABLE IF NOT EXISTS public.mahjong_moves (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id uuid NOT NULL REFERENCES public.mahjong_rooms(id) ON DELETE CASCADE,
    owner_id text NOT NULL DEFAULT auth.uid(),
    seq integer NOT NULL,
    seat integer NOT NULL,
    action jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (room_id, seq)
  );
  ALTER TABLE public.mahjong_moves ENABLE ROW LEVEL SECURITY;
  GRANT SELECT, INSERT ON public.mahjong_moves TO authenticated;

  DROP POLICY IF EXISTS mahjong_moves_read ON public.mahjong_moves;
  CREATE POLICY mahjong_moves_read ON public.mahjong_moves
    FOR SELECT TO authenticated USING (true);

  DROP POLICY IF EXISTS mahjong_moves_insert ON public.mahjong_moves;
  CREATE POLICY mahjong_moves_insert ON public.mahjong_moves
    FOR INSERT TO authenticated
    WITH CHECK (
      owner_id = auth.uid()
      AND EXISTS (
        SELECT 1 FROM public.mahjong_room_members m
        WHERE m.room_id = mahjong_moves.room_id AND m.owner_id = auth.uid()
      )
    );
END $$;
