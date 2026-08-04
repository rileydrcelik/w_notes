"""What a good resume actually looks like, as prompt text.

Every writing endpoint in ``routers/resume.py`` used to carry its own idea of
what a resume should be, restated in each system prompt. That worked while there
was one of them; with four (add an entry, edit, tailor to a posting, harden to a
job title) it meant the same rule was written four times and could disagree with
itself four ways. The rules live here now and are pasted into whichever prompts
need them.

The substance is one specific school of resume writing — the recruiter's view,
where a resume is not a portfolio or a brag sheet but **a form that proves you
meet the minimum qualifications for one job title**, read in about fifteen
seconds by a recruiter and again by a hiring manager. That framing decides
everything downstream: why the page is boring on purpose, why there is a summary
bullet before the achievement bullets, why the keywords have to be near the top,
why "responsible for" is banned, and why a second page is a page nobody reads.

Two deliberate departures from the source material it is drawn from:

- **One page, always.** The source allows a longer resume; this app does not.
  Every document-level endpoint here compiles what it wrote and will not return
  something that came out at two pages while it still has attempts left.
- **Reverse chronological, always.** The source offers a second format (three
  skill buckets) for directors, heavy contractors, and people with more jobs than
  years. Supporting both would mean the model choosing a format for someone's
  existing document and rebuilding it in that format, which is a much larger and
  much less reversible action than anything else here does.

The one thing this file must never do is describe **typography**. The advice it
comes from is specific about fonts, point sizes and line spacing, and all of that
is the LaTeX template's business. Every prompt here is under a hard rule to copy
the preamble through untouched, and a model told "use 10.5pt Arial" will try to
honour it by rewriting `\\documentclass` — producing a document that either
doesn't compile or no longer looks like the one the person chose. Layout is the
template's; this file only ever talks about *what the words are*.
"""

from __future__ import annotations

# --------------------------------------------------------------------------
# The parts of the standard that are about one entry, and nothing wider.
#
# Split out because the adder and the editor genuinely only ever see one entry —
# telling them where the education section belongs would be telling them about a
# document they are not allowed to touch. The document-level endpoints get this
# too, as part of `RESUME_STANDARD` below.
# --------------------------------------------------------------------------
BULLET_STANDARD = """\
## What an entry is made of

Each entry has a heading and then bullets.

The heading carries the job title, the employer, and the location, with the dates
set apart from them. Jobs and internships get **months and years** ("May 2024 --
Aug 2024"); a job someone is still in runs to "Present" in whatever wording the
document already uses. Projects need no months, and often no dates at all.

The **first bullet is a summary bullet**, and it is not an achievement. It says
what the job was, in words someone outside the industry would understand, and it
carries several of the role's keywords. Someone reading only the first line of
each entry should come away knowing what this person did for a living.

Every bullet after it is an achievement bullet, and each one answers three things:

1. **What** — the qualification itself, in the role's own word for it. This is
   the keyword, and it is what a machine reads.
2. **How** — how they actually used it. "Ran Kubernetes" is a claim; "moved 40
   services onto Kubernetes, taking deploys from weekly to daily" is evidence.
3. **Why, or the result** — what it was for, or what changed because of it. This
   is the part almost every resume leaves out, and it is the part a person reads.
   Without it a bullet is a list of tools rather than an account of judgement.

The three overlap in practice, and that is fine. What is not fine is a bullet
carrying only the first of them.

## How a bullet is written

- **Lead with the outcome, not the activity.** The first few words say what
  moved. "Cut onboarding time 40%…", never "Responsible for onboarding…".
- **One sentence.** At most one full stop, and at most three lines on the page. A
  bullet that wraps onto a fourth line is two bullets or one padded one.
- **Past tense throughout**, including the job they are still in.
- **One accomplishment per bullet.** Three sharp bullets beat six vague ones.
- **Quantify only with what you were given** — percentages, money, time,
  throughput, error rates, headcount, scale. Where there is no metric, give scope
  instead: the size of the system, the number of teams, the size of the audience.
- **Method comes last and stays short.** It is the "how", not the point.
- **No two bullets open the same way**, and no bullet repeats a technology
  already named in the entry's tooling line. Say each thing once.

## Words that are banned

"Responsible for", "helped with", "worked on", "assisted", "participated in",
"tasked with". Each of those describes a job description rather than a person's
effect on it, and a reader skips the line as soon as they see one.

## How many bullets

Between three and eight per entry, counting the summary bullet — so two to seven
achievements. A long tenure earns more of them; three months earns three. An
entry with nine bullets is one where nobody chose.
"""


# --------------------------------------------------------------------------
# The whole standard, for the endpoints that write or rearrange a document.
# --------------------------------------------------------------------------
RESUME_STANDARD = (
    """\
# What this resume is for

Its only job is to get an interview. It is not a portfolio, a brag sheet, or a
piece of marketing, and it is not judged on how it looks — it is judged on
whether a reader can tell, quickly, that this person meets the minimum
qualifications for one specific job title.

Two people read it and neither reads it properly. A recruiter screens it against
a list of qualifications a hiring manager gave them, in roughly fifteen seconds.
The hiring manager then gives it about the same. Both are looking for the same
thing: the qualifications, and evidence of how and why this person used them.

So a good resume is **plain, dense, and boring to look at**. It reads like a form
someone filled in. Everything that makes it interesting to look at makes it
slower to read, and slower to read is the only failure mode that matters.

A resume is also **specific to one job title**. A resume that gets someone a
project manager interview will not get them a barista interview, and the fix is
never to write one that tries for both.

# The shape of the page

- **Reverse chronological.** Most recent first, throughout. Never mix in a
  skills-bucket or functional layout; the two formats do not combine.
- **Exactly one page — and a full one.** Not "about a page", and not most of
  one. A second page is read as a first page with something missing off the end
  of it; a page that stops two thirds of the way down is read as someone who ran
  out of things to say. Both break this rule. Only the first is ever noticed,
  which is why the second is the easier mistake to make.
- **One column**, top to bottom. No sidebars, no tables laying out content, no
  text boxes, no photograph, no rating bars or skill percentage meters, no icons
  standing in for words.
- **Roughly twelve years of history**, and no more, unless the target is a
  director-level role.

**Typography and layout are not yours to change.** The document already has a
template, and it is the template's job to decide the font, the sizes, the
spacing, and the margins. Never touch the preamble, never add a package, and
never make the page fit by shrinking type or cutting margins. If it does not fit,
it has too much in it.

# Section order

1. **Name, contact, location.** Name, phone, email, and a LinkedIn or portfolio
   link. City and state; work authorisation ("US Citizen", "Green Card Holder")
   only where the person's own material says so, and languages likewise.

2. **Summary — usually there should not be one.** A summary earns its space in
   exactly three situations, all of which are answers to a question the reader
   would otherwise ask:
   - they are changing industries ("transitioning to X from Y"),
   - they are relocating ("moving to Denver in March, sooner if needed"),
   - they need sponsorship or are on a visa — in which case say plainly what the
     visa allows, because most recruiters and hiring managers do not know the
     difference between H-1B, OPT and TN and will assume the worst.

   Two lines at most. If none of those three apply, there is no summary, and
   removing a generic one that is already there wins back the most valuable space
   on the page.

3. **Education and certificates.** Three lines at most, as bullets: the degree,
   what it was in, and where. A graduation year if it was within about three
   years, otherwise no year at all. Active certificates need no dates.

   **This section moves to the bottom of the page** when the target job does not
   require a degree, or when leading with the degree would make the person look
   overqualified for it.

4. **Experience, then projects and internships.** The bulk of the page.

# Keywords

The qualifications are the whole game, and where they sit on the page decides
whether anyone sees them.

- Aim to have most of the role's keywords — three quarters of them — in the
  **top half of the first page**. That is what gets read.
- Use **the role's own word** for a thing. If the role says "Kubernetes" and the
  resume says "K8s", write Kubernetes. If the role says "CI/CD" and the resume
  says "build pipelines", say both. A keyword a reader does not find is a
  requirement they assume is unmet.
- **Never claim a keyword the person's own material does not support.** Matching
  a qualification they do not have is what gets someone caught out in an
  interview, and it is worse than not matching it.

"""
    + BULLET_STANDARD
)


__all__ = ["BULLET_STANDARD", "RESUME_STANDARD"]
