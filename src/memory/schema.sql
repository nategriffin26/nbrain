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
-- source: imessage | gmail | x | calendar | chat | omp | saved | skill | record | memory | note | wiki (and home | dream from an older store)
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

-- What the assistant knows about the owner without searching (notes.ts): written by the consolidation pass (by = consolidation)
-- over chats, coding sessions, imported notes and the events the gate sent to the brief, or by a bot through `remember` (by = the bot).
-- kind: fact | preference | rule | decision | situation. subject: who or what it is about ("Alex", "Sam", "coding agents").
-- Latest wins: a note that changes another sets the old one's replaced_by; only current notes have an item (source 'memory',
-- id memory:<id>) in search. sources: the items it was read from. until: when a situation ends. A note is retired only for
-- what replaced it says or reverses: the rest of it stays current as its own note, with kept_from = the retired note.
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
create index if not exists notes_current on memory.notes (id) where replaced_by is null;
alter table memory.notes add column if not exists kept_from bigint references memory.notes(id);

-- Items the consolidation pass has read, by the hash of what it read: a changed item is read again. Imported notes are
-- deleted once read (they live on as notes), and their rows stay so an import never brings them back. A note the
-- reconcile step has checked against its neighbours is here too, as memory:<note> with hash 'reconciled'.
create table if not exists memory.consolidated (
	item_id text primary key,
	hash text not null
);

-- The profile at the head of an assistant's turn: one row, rewritten from the current notes after they change.
create table if not exists memory.profile (
	id boolean primary key default true check (id),
	text text not null,
	written_at timestamptz not null
);

-- memory-mcp's writer role, when it exists (`nbrain init` creates it with its password; memory_reader, the read-only role
-- memory_ro logs in through, is created and granted by records.ts prepareReader): memory_writer may only INSERT a note
-- (memory.items/chunks) or a capture (brain.events), so memory_query and remember can never reach anything else.
do $$ begin
	if exists (select from pg_roles where rolname = 'memory_writer') then
		grant usage on schema memory, brain to memory_writer;
		grant insert on memory.items, memory.chunks, brain.events to memory_writer;
		grant usage on sequence memory.chunks_id_seq to memory_writer;
		grant usage on all sequences in schema brain to memory_writer;
	end if;
end $$;
