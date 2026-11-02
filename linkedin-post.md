Every agent harness I use wanted its own copy of the same skills.

Claude Code had 212. agy had 1. Codex had yesterday's version. Cursor had the one from two weeks ago. Installing a skill meant pasting it into seven directories. Updating meant seven edits. Deleting meant hunting seven leftovers — and then explaining to someone why two agents disagreed about the same instruction.

I spent an afternoon writing sync scripts for it. That was the wrong fix. The bug was never that the copies drifted. The bug was that I was maintaining copies.

So I deleted the copies.

One directory now holds every skill:

    C:\Users\ADMIN\.agents\skills

Every harness points at that one directory. On Windows: 14 NTFS junctions. In WSL: 7 symlinks into the same folder. 247 skills, one copy on disk, 21 pointers, zero duplicates.

Then I wrote skillhub so I never have to think about it again:

→ install — lands in the store, every agent sees it
→ remove — gone everywhere, instantly
→ status — every root, linked or not, with live counts
→ repair — re-links anything a package manager clobbered
→ doctor — 6/6 PASS, or tells me exactly why not

Verified live, not by inspection: I dropped a new skill into the store and asked agy and Claude Code, on Windows and in WSL. All four saw it immediately. Install → visible everywhere in seconds. Remove → gone everywhere in seconds.

The part I didn't expect: I stopped treating skills as installed software and started treating them as code. One source of truth. Diffable. Git-friendly. Reviewable.

That's the real lesson. If two agents behave differently, the first thing to check isn't their prompts — it's whether they're even running the same skill version. Now they always are.

Tool, setup script and the full write-up: https://github.com/aswathas/skillhub

Took one afternoon to notice the problem, twenty minutes to delete it.

What are you shipping this week?

#buildinpublic
