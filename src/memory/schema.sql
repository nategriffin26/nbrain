-- The brain's tables. Applied by the ingest process at start (idempotent). Two schemas:
--   brain   the raw intake: one event per thing a connector or a capture read (events), each connector's position
--           (cursors) and the model chosen for each role (model_roles). Connectors write here; nothing else does.
--   memory  everything derived from it, verbatim and searchable (items, chunks, people, records, notes, profile).
--           memory/store.ts writes, memory/search.ts reads; memory-mcp reads it as memory_ro.
-- pg_search wants pgvector's type in public.
create extension if not exists vector schema public;
create extension if not exists pg_search;
create schema if not exists brain;
create schema if not exists memory;

-- One row per thing read: a mail, a text, a calendar event, a bookmark, a chat turn, a work turn, a capture.
-- kind: mail.received | mail.sent | text.received | text.sent | calendar.changed | x.bookmark | chat.turn | work.turn | capture
-- Deduped on (source, external_id); a connector that reads a changed copy rewrites title/body/url/data in place.
-- triage/route/routed_at: kept for stores that came from an engine that routed events; the brain never reads them.
create table if not exists brain.events (
	id bigserial primary key,
	kind text not null,
	source text not null,
	external_id text,
	at timestamptz not null,
	title text,
	body text,
	url text,
	data jsonb not null default '{}',
	triage jsonb,
	route text,
	routed_at timestamptz,
	received_at timestamptz not null default now(),
	unique (source, external_id)
);
create index if not exists events_by_time on brain.events (at desc);

-- A change counter, so the indexer asks for "rev above the one I reached" instead of comparing every row: rev takes a new
-- value when a row is inserted and when its title, body, url, data or time change.
create sequence if not exists brain.events_rev_seq;
alter table brain.events add column if not exists rev bigint not null default nextval('brain.events_rev_seq');
create index if not exists events_by_rev on brain.events (rev);
create or replace function brain.events_touch() returns trigger language plpgsql as $$ begin new.rev := nextval('brain.events_rev_seq'); return new; end $$;
create or replace trigger events_touch before update on brain.events for each row
	when (old.title is distinct from new.title or old.body is distinct from new.body or old.url is distinct from new.url or old.data is distinct from new.data or old.at is distinct from new.at)
	execute function brain.events_touch();

-- Where each connector and loop reached, and whether its last run failed. Freshness: now() - last_ok_at per source.
create table if not exists brain.cursors (
	source text primary key,
	cursor text,
	last_ok_at timestamptz,
	last_error text,
	updated_at timestamptz not null default now()
);

-- The model and thinking level of a role (reading, extraction, notes); a role without a row uses the seed in models.ts.
create table if not exists brain.model_roles (
	role text primary key,
	model text,
	thinking text,
	updated_at timestamptz not null default now()
);

-- One row per raw thing: a text, a mail, a record, a calendar event, a bookmark, a chat turn, a note, a capture, a skill.
-- id: `<source>:<external_id>` of the brain.events row it came from (or an id from an older store the brain was loaded
-- from). One item per (source, ext_id): a later copy rewrites it in place.
-- source: imessage | gmail | x | calendar | chat | omp | saved | research | skill | record | note | wiki (and home | dream from an older store)
-- kind: message | post | event | record | fact | note | page | doc
-- origin: event (from brain.events) | note (memory-mcp's remember) | skill (the skills index) | context (loaded from an older store; an event's copy wins over it)
create table if not exists memory.items (
	id text primary key,
	source text not null,
	kind text not null,
	ext_id text,
	thread text,
	thread_title text,
	title text not null default '',
	at timestamptz not null,
	sender text,
	sender_name text,
	recipients jsonb not null default '[]',
	from_me boolean not null default false,
	url text,
	body text not null,
	meta jsonb not null default '{}',
	hash text not null, -- sha256 of what was indexed: a changed copy rewrites the item's chunks
	origin text not null,
	event_id bigint,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);
create unique index if not exists items_by_ext on memory.items (source, ext_id);
create index if not exists items_by_thread on memory.items (source, thread, at);
create index if not exists items_by_at on memory.items (at);
create index if not exists items_by_event on memory.items (event_id);

-- People and organisations; handles are folded (addresses lowercased, phones +digits). self is the owner.
-- kind: person | org | self
create table if not exists memory.people (
	id text primary key,
	kind text not null,
	name text not null,
	aliases jsonb not null default '[]',
	handles jsonb not null default '[]',
	relationship text,
	meta jsonb not null default '{}'
);
create index if not exists people_by_handle on memory.people using gin (handles);

-- Who is on each item. role: sender | recipient | mentioned | subject
create table if not exists memory.item_people (
	item_id text not null references memory.items(id) on delete cascade,
	person_id text not null references memory.people(id) on delete cascade,
	role text not null,
	primary key (item_id, person_id, role)
);
create index if not exists item_people_by_person on memory.item_people (person_id, item_id);

-- What search ranks: each item's body cut into chunks (text.ts chunkBody), with its heading (item title — section), the
-- people on it, the line of context that places it (written by a model: capture enrichment, imports) and its local embedding
-- (Qwen3-Embedding-0.6B, 1024 dims). embed_hash keys the embedding input, so an unchanged chunk keeps its vector.
create table if not exists memory.chunks (
	id bigserial primary key,
	item_id text not null references memory.items(id) on delete cascade,
	part integer not null,
	start_at integer not null,
	end_at integer not null,
	heading text not null,
	people text not null,
	context text not null,
	text text not null,
	embed_hash text not null,
	embedding halfvec(1024) not null,
	unique (item_id, part)
);
-- BM25 over the words (ParadeDB), English stems, accents folded.
create index if not exists chunks_words on memory.chunks using paradedb (
	id,
	(heading::pdb.unicode_words('stemmer=english', 'ascii_folding=true')),
	(people::pdb.unicode_words('stemmer=english', 'ascii_folding=true')),
	(context::pdb.unicode_words('stemmer=english', 'ascii_folding=true')),
	(text::pdb.unicode_words('stemmer=english', 'ascii_folding=true'))
);
create index if not exists chunks_meaning on memory.chunks using hnsw (embedding halfvec_cosine_ops);

-- Typed records read out of items, so who / how many / how much / latest are answered by SQL (records.ts; the memory_query tool).
-- id: an imported `r-…` id (also the id of the `record` item that renders it) or `rec:<item_id>` for one read by the extraction role.
-- type: bill | payment | order | appointment | commitment | request | plan | family_date. item_id: the mail, text or calendar event it was read from.
-- amount in `currency` (USD unless stated); due_at: when a bill falls due; paid_at: when a payment was made or an order placed;
-- start_at / end_at: an appointment. A later record of the same thing (same_as: an order or booking by org and ref, a bill or payment by org, amount and day) supersedes the earlier.
create table if not exists memory.records (
	id text primary key,
	item_id text not null references memory.items(id) on delete cascade,
	type text not null,
	org text,
	title text not null default '',
	people jsonb not null default '[]',
	amount numeric(14, 2),
	currency text,
	due_at timestamptz,
	paid_at timestamptz,
	start_at timestamptz,
	end_at timestamptz,
	status text,
	ref text,
	at timestamptz not null, -- when its item was sent
	extractor text not null,
	fields jsonb not null default '{}',
	supersedes text,
	superseded_by text,
	same_as text
);
create index if not exists records_by_item on memory.records (item_id);
create index if not exists records_by_type on memory.records (type, at desc);
create index if not exists records_by_org on memory.records (lower(org));
create index if not exists records_by_same on memory.records (same_as) where same_as is not null;

-- Items the extraction role has read (or that cannot hold a record), by the hash of what it read: a changed item is read again.
create table if not exists memory.extracted (
	item_id text primary key references memory.items(id) on delete cascade,
	hash text not null,
	state text not null, -- read | skipped | context (imported with its records)
	at timestamptz not null default now()
);

-- Retired (kept as history, read by nothing): notes a consolidation pass wrote over chats, sessions and texts, and the
-- life profile rewritten from them. Audited stale and noisy (most of them), they gave way to the profile files in the
-- context repo (curator.ts), which change only from the owner's own words and corrections.
create table if not exists memory.notes (
	id bigserial primary key,
	kind text not null,
	subject text not null,
	text text not null,
	at timestamptz not null,
	until timestamptz,
	sources text[] not null default '{}',
	by text not null,
	replaced_by bigint references memory.notes(id),
	created_at timestamptz not null default now()
);
alter table memory.notes add column if not exists kept_from bigint references memory.notes(id);
create table if not exists memory.consolidated (
	item_id text primary key,
	hash text not null
);
create table if not exists memory.profile (
	id boolean primary key default true check (id),
	text text not null,
	written_at timestamptz not null
);

-- What the owner marked private (the `private` tool): an item id, or a whole thread as thread:<source>:<thread>. Search,
-- briefs, the library and every derived layer leave it out; a life-scope search asking for private finds it. Deleting the
-- row undoes it.
create table if not exists memory.private (
	target text primary key,
	why text,
	by text not null,
	at timestamptz not null default now()
);

-- Corrections an agent passed on (the `correct` tool): what is wrong and what is right, about a record, card, item or
-- profile change when known. The curator applies each within a minute (records.superseded_by = 'correction:<id>', a
-- card rewritten, profile lines closed and added with this as their source); a line sourced to a correction changes only
-- by a later correction.
create table if not exists memory.corrections (
	id bigserial primary key,
	target text,
	text text not null,
	by text not null,
	at timestamptz not null default now()
);

-- The library: one card per bookmark, saved page or post worth keeping (library/cards.ts). id card:<item_id>.
-- kind: tool | technique | reference | idea | read | person. what: what it is, in a sentence. why: why it fits the owner
-- (their projects, tastes, what they asked for). craft: for a reference, what is good about it in craft terms. url: the
-- thing itself (a tool's site, the page a post points at) when that is not the item's url. status: new | tried | adopted |
-- dropped, set by an agent that used it (library_mark). capture: files under $BRAIN_HOME (screenshot png, archive html,
-- recording webm). hash: the item hash the card was written from; a changed item is carded again.
create table if not exists memory.cards (
	id text primary key,
	item_id text not null unique references memory.items(id) on delete cascade,
	kind text not null,
	what text not null,
	why text not null,
	craft text,
	projects text[] not null default '{}',
	url text,
	status text not null default 'new',
	status_note text,
	status_by text,
	status_at timestamptz,
	capture jsonb not null default '{}',
	model text not null,
	hash text not null,
	at timestamptz not null,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);
create index if not exists cards_by_kind on memory.cards (kind, status);
-- corrected: the fields a correction set, as {"what": "correction:<id>", …}; a later triage keeps those fields.
alter table memory.cards add column if not exists corrected jsonb not null default '{}';
-- Items the triage read and found nothing worth a card in, by hash: a changed item is read again.
create table if not exists memory.uncarded (
	item_id text primary key references memory.items(id) on delete cascade,
	hash text not null,
	at timestamptz not null default now()
);

-- memory-mcp's writer role, when it exists (`nbrain init` creates it with its password; memory_reader, the read-only role
-- memory_ro logs in through, is created and granted by records.ts prepareReader): memory_writer may INSERT a note
-- (memory.items/chunks), a capture (brain.events) or a correction, mark and unmark private, and set a card's status, so
-- sql, remember and the other writes can never reach anything else. It is never a member of memory_reader (that would
-- let it read every table); an install that made it one has that taken back here.
do $$ begin
	if exists (select from pg_roles where rolname = 'memory_writer') then
		grant usage on schema memory, brain to memory_writer;
		grant insert on memory.items, memory.chunks, brain.events, memory.corrections to memory_writer;
		grant usage on sequence memory.chunks_id_seq, memory.corrections_id_seq to memory_writer;
		grant usage on all sequences in schema brain to memory_writer;
		grant select, insert, delete on memory.private to memory_writer;
		grant select (id), update (status, status_note, status_by, status_at, updated_at) on memory.cards to memory_writer;
		if exists (select from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles w on w.oid = m.member
				where r.rolname = 'memory_reader' and w.rolname = 'memory_writer') then
			revoke memory_reader from memory_writer;
		end if;
	end if;
end $$;
