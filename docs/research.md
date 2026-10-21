# The research behind nbrain

nbrain is one memory server that many agents share. It keeps a person's verbatim history, a small curated profile, and the skills and styles agents have distilled from finished work. Before the design settled, a research pass in October 2026 asked one question: **what should such a server store, how should it stay current, how should agents find things in it, and how should reusable know-how be written and served, given what has actually been measured?** It also asked the reverse question: which popular techniques have measured costs that outweigh their gains?

Nine research lanes each answered part of the question. Every claim below rests on a fetched source, linked beside it. Much of the evidence is one study or a vendor reporting on its own product; where that is so, or where sources disagree, the text says so. Each section gives the finding, then the decision nbrain took and the file it lives in.

## Skills and styles

**Finding.** Who writes a skill, and when, matters more than anything else about it. SkillsBench ran 87 tasks across 18 model and harness configurations. Curated skills raised the mean pass rate from 33.9% to 50.5% (+16.6 points) ([paper](https://arxiv.org/pdf/2602.12670)). Skills the agent wrote for itself *before* the task, from what it already knew, landed below having no skills at all: −8.1, −11.3 and −11.5 points on the three configurations tested ([SkillsBench 1.1](https://www.skillsbench.ai/blogs/skillsbench-1-1)). Skills distilled *after* the work, from execution traces, go the other way. Trace2Skill gained +17.5 to +21.5 points, while a draft written from the model's own knowledge scored about the same as no skill (26.17% vs 27.67%) ([Trace2Skill](https://arxiv.org/html/2603.25158v3)). Agent Workflow Memory reported +24.6% and +51.1% relative gains ([AWM](https://arxiv.org/pdf/2409.07429)), and ReasoningBank +8.3 points on WebArena ([Google Research](https://research.google/blog/reasoningbank-enabling-agents-to-learn-from-experience/)). None of these studies tested human review as a separate variable, so the value of the owner's sign-off is inferred, not measured.

The same benchmark also measured how size and count change the gain ([SkillsBench](https://arxiv.org/pdf/2602.12670)):

| Skill property | Gain over no skills |
|---|---|
| Compact / standard length | +19.0 / +21.5 pp |
| Detailed | +14.5 pp |
| Comprehensive documentation | +0.7 pp |
| 1 skill / 2-3 skills per task | +18.0 / +19.0 pp |
| 4 or more skills per task | +10.1 pp |

Relevance alone does not make a skill safe. In 13 of 87 tasks, curated skills made results worse, and the common cause was one heavyweight "correct" pipeline that had no applicability boundaries ([SkillsBench](https://arxiv.org/pdf/2602.12670)). A separate audit found that 68.8% of skill-induced functional failures came from relevant-looking skills that prescribed the wrong specifics; only 1.6% came from plainly irrelevant ones ([arXiv 2608.11888](https://arxiv.org/html/2608.11888v1)). On real repositories, 49 public coding skills averaged +1.2 points at +10.5% token cost, and about 80% of them changed nothing ([SWE-Skills-Bench](https://arxiv.org/html/2603.15401v1)). Rewriting a skill wholesale is risky too: in one ACE run, a single rewrite step shrank a context from 18,282 tokens to 122 and dropped accuracy from 66.7 to 57.1, below the 63.7 baseline with no adaptation at all ([ACE, ICLR 2026](https://proceedings.iclr.cc/paper_files/paper/2026/file/8a94ff6f922d995d7d3f4ebf4143e442-Paper-Conference.pdf)).

For taste, the strongest public examples write each judgment as a rule, its reason and an exact value: scale(0.95) rather than scale(0), UI motion under 300 ms ([Agents with Taste](https://emilkowal.ski/ui/agents-with-taste)). They also plan before critiquing ([frontend-design](https://raw.githubusercontent.com/anthropics/skills/HEAD/skills/frontend-design/SKILL.md)). Practitioners prefer styles invoked for a task over styles that are always on ([survey of design skills](https://aridanemartin.dev/blog/design-skills-for-developers/)), but that preference is consensus; no controlled comparison exists.

**Decision.** Skills and styles are [Agent Skills](https://agentskills.io/specification) directories in the owner's context repo. The two built-in guides, `skills/write-skill/SKILL.md` and `skills/write-style/SKILL.md`, set the bar for writing them:

- Write only after the owner has accepted the work, and only from that session's trace.
- Quote the owner's corrections verbatim.
- State every rule as rule + why + value.
- Keep the body compact, with boundaries and a lighter path for small versions of the task.
- Write a description specific enough that an agent actually picks the skill.

Each style carries a one-line thesis, 3-7 principles, a token block, the defaults it refuses, and 1-3 screenshots. A style becomes the default only when the owner says so, and `context_get` lists it rather than injecting it.

`saveSkill` in `src/skills/library.ts` enforces two things. An update must name the digest of the SKILL.md its writer read, so writers merge changes instead of rewriting from memory. Every save is a signed git commit the owner can read or revert. Bodies over 500 lines draw a warning.

## Exemplars

**Finding.** More examples help only up to a point. Across seven LLMs, classification accuracy peaked at about 5-20 examples chosen by similarity and then declined ([over-prompting study](https://arxiv.org/html/2509.13196v1)). Retrieving programs similar to the task teaches a model "how to write" ([AceCoder](https://arxiv.org/abs/2303.17780)). Examples also anchor: agents copied a template's API version and protocol verbatim instead of adapting them ([SWE-Skills-Bench](https://arxiv.org/html/2603.15401v1)). Model output also converges, with each added model-written essay contributing less diversity than a human one ([survey](https://arxiv.org/html/2604.01504v1)). The evidence is thin and partly contested. The count studies cover classification, many-shot work on broad tasks finds the opposite trend, and no controlled study of exemplars for UI or code generation turned up. Screenshots catch static drift in spacing and colour but cannot show hover states, motion or content below the fold ([Digital Applied](https://www.digitalapplied.com/blog/screenshot-driven-ui-development-vision-models-2026)).

**Decision.** Exemplars are not a separate store. A skill keeps 1-3 of them in `examples/`. Each holds the artifact or a pointer to it, a 5-15 rule "craft extract", 1-3 contrast pairs, and an explicit do-not-copy list. The rule is one exemplar per task, the closest one (`skills/write-skill/SKILL.md`, "Exemplars"). Style screenshots each come with a line on what to take from them and what not to copy. Worked examples ship as `skills/write-skill/examples/explainer.md` and `skills/write-style/examples/ledger.md`.

## Capture and retrieval of saved things

**Finding.** On plain articles, the major web extractors give similar results (F1 0.871-0.932). They diverge sharply on forums (0.520-0.794) and collection pages ([WCXB](https://arxiv.org/html/2605.21097v1)). Defuddle, the extractor behind a popular web clipper, has no public benchmark ([README](https://github.com/kepano/defuddle/blob/HEAD/README.md)). For PDFs, Docling led on complex tables with 97.9% cell accuracy, but that test was a consultancy's five table-heavy reports ([Procycons](https://procycons.com/en/blogs/pdf-data-extraction-benchmark/)).

Pages disappear: 25% of pages that existed between 2013 and 2023 were gone by late 2023, including 38% of the 2013 pages ([Pew](https://www.pewresearch.org/data-labs/2024/05/17/when-online-content-disappears/)). Prepending a 50-100-token context line, written by an LLM for each chunk, cut top-20 retrieval failures by 35% with embeddings, 49% with BM25 added, and 67% with reranking added. Generic document summaries helped little ([Anthropic](https://www.anthropic.com/engineering/contextual-retrieval); vendor self-evaluation). Late chunking lifted NFCorpus nDCG@10 from 23.46 to 29.98, with gains growing with document length ([Jina](https://jina.ai/news/late-chunking-in-long-context-embedding-models/); vendor).

**Decision.** `src/capture/read.ts` routes each save by type:

- X posts go through post hydration and YouTube through transcripts.
- PDFs go through unpdf, and a scan with no text layer is refused.
- Pages go through Defuddle. A page that yields fewer than 200 words, or refuses a plain fetch, is read again through a rendering fetch.
- URLs are canonicalised (tracking parameters removed), and a repeat save of the same thing is recognised.

`src/capture/save.ts` keeps the fetched bytes (gzipped HTML or the PDF, up to 25 MB) next to the text, because the source may vanish. `src/capture/enrich.ts` makes one model call per item. The call returns a 2-3 sentence summary, up to five tags (reusing existing tags where they fit), and a context sentence for each chunk. The context goes into the chunk's indexed text for both BM25 and the embedding. Late chunking and Docling were not adopted. The embedder takes inputs of at most 2,000 characters (`src/memory/store.ts`), and Docling's advantage was measured on table-heavy reports. Both are listed under open questions.

## Memory maintenance and the gardener

**Finding.** Doing the expensive thinking offline pays off. Sleep-time compute reached the same accuracy with about 5× less test-time compute and cut the average cost per query 2.5× ([arXiv 2504.13171](https://arxiv.org/html/2504.13171v1)). Vendors have converged on scheduled consolidation that keeps history. Honcho dreams only after at least 50 new conclusions, 8 hours since the last dream, and 60 idle minutes ([docs](https://honcho.dev/docs/v3/documentation/features/advanced/dreaming), [analysis](https://spanthi.com/blog/ai-memory-dreaming/)). Mem0's weekly Dream marks entries merged or superseded and deletes nothing ([Mem0](https://mem0.ai/blog/dream-background-memory-consolidation-for-ai-agents)). None of these vendors has published an A/B test of consolidation on versus off.

The way consolidation writes is where it goes wrong:

- Under repeated irreversible summarization, end-task error grew super-linearly, while retrieval-backed memory stayed flat ([rate-distortion survey](https://arxiv.org/html/2607.08032v1)).
- One coding agent's compaction prompt kept 53% of safety rules after one round and 10% after five ([Compaction Cliff](https://arxiv.org/html/2608.22752v1)).
- LLM-generated repository context files cut agent success by about 3% and raised cost by 20% or more, while developer-written ones added about 4% ([arXiv 2602.11988](https://arxiv.org/html/2602.11988v1)).
- A two-stage curated writer made half the audited errors of single-call extraction (4.0 vs 8.5) and recalled more facts (84.5% vs 74.6%) ([Ground Truth First](https://arxiv.org/html/2607.21962v1)).
- Across 18 models, performance fell as input grew longer, even at fixed difficulty ([Chroma](https://www.trychroma.com/research/context-rot)).

The defensible way to handle contradictions is "recency wins with explicit invalidation", not deletion ([Hindsight](https://hindsight.vectorize.io/blog/2026/05/21/agent-memory-consolidation), [db0](https://db0.ai/blog/why-agents-forget)).

**Decision.** Maintenance works in two layers.

`src/memory/notes.ts` holds notes, which are short statements about the owner. A consolidation pass proposes notes from chats and coding sessions. For coding sessions, `src/connectors/omp.ts` reads only the owner's own turns in top-level sessions, never subagent traffic. A second call checks each new note against the current notes nearest to it. The newest note wins through `replaced_by`. Nothing is rewritten or deleted: any part of a retired note that was not replaced stays as a note of its own. Only current notes appear in search, and records chain `superseded_by` the same way.

`src/garden.ts` is the nightly gardener. It writes yesterday's journal and proposes line edits to the curated profile files. It never rewrites a file. Every edit must cite evidence the model was shown, and edits that cite none are dropped. "No change" is the expected answer. Each file has a byte budget, and a set of edits that would break the budget is dropped whole. On the owner's goals file the gardener may only propose. Every changed file becomes its own git commit, a day is gardened once, and mail and texts stay out of the journal's evidence because they are other people's words.

## Retrieval and fusion

**Finding.** Once a system has judged queries, a tuned convex combination of lexical and dense scores beats reciprocal rank fusion (RRF). It wins both in and out of domain, and its weight converges with under 5% of the training data ([Pinecone summary of Bruch et al.](https://pinecone.io/research/an-analysis-of-fusion-functions-for-hybrid-retrieval/)). RRF has its own costs ([BigDataBoutique](https://bigdataboutique.com/blog/hybrid-search-fusion-methods-compared)):

| Setting | Result |
|---|---|
| Touché: BM25 alone / dense alone / RRF of both | 0.650 / 0.390 / 0.604 nDCG@10 |
| RRF vs score-based hybrid, six BEIR sets | 3.86% lower nDCG@10, under 2% faster |
| Late-interaction rerank vs RRF, DBpedia | 0.722 vs 0.668 |

Adapting weights per query recovered only a median 12.2% of the oracle headroom ([arXiv 2610.24341](https://arxiv.org/html/2610.24341v1)). Cross-encoders fell below plain RRF on long documents because of truncation; that comes from a single secondary source ([BigDataBoutique](https://bigdataboutique.com/blog/hybrid-search-fusion-methods-compared)).

**Decision.** `src/memory/search.ts` runs these channels side by side:

- BM25 through ParadeDB, with headings boosted ×2 and people ×1.5.
- Cosine similarity over Qwen3-Embedding-0.6B vectors in pgvector.
- Date, person and source channels when the query names one.
- A newest-first channel when the query asks for the "latest" of something.
- A channel for identifiers: words with digits that are at least five characters long.

The 100 best results from each channel are fused by RRF with k = 60. Hits that match every filter the query names, or that contain a code it names, count triple. Each item gets one hit, its best chunk. A local Qwen3 cross-encoder reorders the top 30, using 500 characters per candidate, and keeps the fused rank as a 4:1 prior. If the reranker is down, search falls back to the fused order.

RRF was chosen because a fresh install has no judged queries, and RRF needs no calibration between BM25 and cosine scores. The ×3 weight and the 4:1 prior were set by hand and have not been tuned. Dated channels only boost results; they never filter them. Chunk text is kept verbatim, and embeddings are keyed by a hash of their input (`src/memory/schema.sql`), so changing the embedding model can be an online migration with dual writes ([omiid](https://omiid.me/notebook/64/embeddings-rot-too-running-pgvector-in-production)).

## Serving skills over MCP

**Finding.** The MCP Skills extension (SEP-2640) became Final on 2026-09-13 as `io.modelcontextprotocol/skills` ([overview](https://modelcontextprotocol.io/extensions/skills/overview)). A server that declares it implements `skills/list` and `skills/get`. Entries carry sha256 digests, and each skill is limited to 512 files and 16 MiB. Results must carry `ttlMs` and `cacheScope`, and there is no notification when a skill changes ([spec](https://github.com/modelcontextprotocol/ext-skills/blob/HEAD/specification/stable/skills.mdx)). The TypeScript SDK's typed API, PR #2818, was still in progress, so servers write their own schemas ([PR](https://github.com/modelcontextprotocol/typescript-sdk/pull/2818)). No major host consumed the extension yet ([implementations](https://github.com/modelcontextprotocol/ext-skills/blob/HEAD/docs/implementations.md)). The spec allows fallbacks: skill URIs listed in the server's instructions, and `skill://` files read as ordinary resources.

Finding the right skill depends on its body. BM25 over name and description alone scored 0 Hit@1 on an 80K-skill pool, versus 34.7% with the body, and a cross-encoder put 91.7% of its attention on the body ([SkillRouter](https://arxiv.org/html/2603.22455v1)). When an LLM picks from a flat list, accuracy drops sharply once the list grows: fitted capacity was about 84-92 skills, and accuracy was about 20% at 200 ([arXiv 2601.04748](https://arxiv.org/html/2601.04748v2)). Getting agents to use skills at all is a separate problem. One audit found 52 of 65 installed skills never used in a month ([thread](https://www.reddit.com/r/ClaudeCode/comments/1syx4tr/i_audited_30_days_of_my_claude_code_sessions_and/?sort=top)). Another author measured activation at 20% with a simple prompt hook and 84% with a forced-evaluation hook ([thread](https://www.reddit.com/r/ClaudeCode/comments/1oywsa1/claude_code_skills_activate_20_of_the_time_heres/?sort=top)). Both are single practitioner reports.

**Decision.** `src/skills/mcp.ts` serves skills four ways, because hosts differ in what they read:

1. The `skill_get` and `skill_save` tools, which any host can call.
2. Every skill file as a `skill://` resource.
3. The extension itself: `skills/list` in pages of 50, and `skills/get`, with hand-written schemas, digest manifests, and a private 60-second cache.
4. A catalog of at most 1.5 KB in the server instructions, saying to load 1-3 skills per task, plus a `context_get` section listing the three best matches for the topic and any defaults.

The matches come from memory search over each skill's full body, which `src/skills/indexer.ts` indexes as an item. The extension's integrity and approval rules apply only on its own path; the fallback channels deliver the content without them.

## Evaluation

**Finding.** An LLM judge is a measuring instrument and has to be validated like one. In a study of 54 judges on 1,994 samples, correlation with humans was not enough on its own; the judges that passed reached Cohen's kappa of 0.781-0.816 ([Judge's Verdict](https://arxiv.org/html/2510.09738v1)). Memory rankings also flip as history grows. A budgeted memory that led at three weeks fell from 96% to 72% recall by nine weeks once early content was evicted ([Ground Truth First](https://arxiv.org/html/2607.21962v1)).

**Decision.** `src/eval/recall.ts` runs each question in the owner's question file through search, just as `memory_search` does (all sources, reranked, ten hits). A question passes only if every expected fact string appears in the rendered hits. There is no LLM judge, so there is no judge to drift. Each miss is attributed to the stage that lost it: never reached a channel, ranked below the cut at a given fused rank, shown without the fact, or no gold item in memory. Expected notes follow their replacement chain, so a superseded note's successor still counts. The question set and its results stay in the owner's data directory. nbrain therefore ships no public benchmark, and the eval measures retrieval only, not choosing a skill, the quality of the gardener's edits, or capture fidelity.

## What nbrain deliberately does not do

- **Write skills before the task.** Skills written up front from the model's own knowledge scored 8-12 points below having none ([SkillsBench](https://arxiv.org/pdf/2602.12670)).
- **Compile an auto-maintained wiki.** On MEME, a Karpathy-style wiki scored 0.10 at $1.388 per episode, against 0.42 at $0.056 for a single flat markdown file ([MEME](https://arxiv.org/html/2605.12477v1)). The evidence is contested: one team's 72-run benchmark found a wiki used 54% fewer tokens on synthesis tasks while losing on single lookups ([Roboco](https://roboco.io/en/posts/karpathy-llm-wiki-72-run-benchmark/)). nbrain keeps flat notes with explicit supersession.
- **Decay memories over time.** No controlled evidence shows that Ebbinghaus-style decay ([MemoryBank](https://arxiv.org/pdf/2305.10250)) improves retrieval, and evicting old content is what broke long-horizon recall ([Ground Truth First](https://arxiv.org/html/2607.21962v1)). Recency is used only when a query asks for it.
- **Rank by usage.** Reinforcing whatever gets retrieved creates a loop that cannot demote a bad note ([essay](https://swapnanilsaha.com/blog/recall-is-a-write-operation/); single source).
- **Run an agentic search loop.** Agentic RAG cost 3.3× the input tokens, 1.9× the output tokens and 1.5× the time, and a fixed reranker was better at choosing the final documents ([arXiv 2601.07711](https://arxiv.org/pdf/2601.07711)). Search returns one ranked pass; the calling agent decides whether to search again.
- **Use HyDE.** HyDE raised zero-shot Contriever's nDCG@10 on TREC DL19 from 44.5 to 61.3 ([ACL 2023](https://aclanthology.org/2023.acl-long.99.pdf)). Each query, though, costs a model call, and the gains concentrate where the dense retriever is weak. It is untested on top of BM25 plus a reranker.
- **Stuff context or install public skill packs.** Longer context degrades every model tested ([Chroma](https://www.trychroma.com/research/context-rot)). An audit of 3,984 public skills found 13.4% with a critical issue and 76 malicious payloads ([Snyk](https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/)).

## Open questions worth an experiment

- **Tuned convex fusion.** Once an install has enough judged queries, fit α ([Bruch et al.](https://pinecone.io/research/an-analysis-of-fusion-functions-for-hybrid-retrieval/)) jointly with the 4:1 reranker prior, and compare against RRF on the recall eval.
- **Rerank depth and input.** Reranking more than 30 candidates, sending more than 500 characters each, or using late interaction for long saved documents.
- **HyDE on hard misses.** Running HyDE only on eval misses whose items never reached any channel, to see whether a hypothetical document recovers them.
- **PDF and long-document capture.** Docling against unpdf on table-heavy PDFs; late chunking with a long-context embedder for long saves.
- **Skill selection at scale.** As the library passes about 20 skills, measure how often the top three include the right skill. Test pseudo-query augmentation, which added +6.70 points of Recall@1 ([Skill2Query](https://arxiv.org/pdf/2608.16071)).
- **Does the gardener pay?** No vendor has published an on/off test. Running the recall eval and a fixed set of agent tasks with and without a month of gardener edits would be the first.
- **Exemplar count.** Zero, one or three exemplars on the same brief, judged blind by the owner.
- **Abstention.** Set-level sufficiency checks reached 0.9075 Macro-F1, against 0.6516 for mean-pooling ([SURE-RAG](https://arxiv.org/html/2605.03534v1)). The open question is whether search should say when its hits cannot answer the question.
