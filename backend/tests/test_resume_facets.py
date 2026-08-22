"""`_facets()` in `app/routers/resume.py` — the permissive builder that turns
whatever a tailoring pass returned into a storable `TailorFacets`.

The schema (`_TAILOR_SCHEMA`) makes a well-formed object close to guaranteed
from a real model call, so this isn't really a defence against the model — it's
a defence against the shapes `block` takes on paths that never asked for facets
at all (an empty dict, or a dict shaped by something else entirely). Per the
function's own docstring: "Nothing in here can fail the request." These tests
hold it to that, plus the one transformation it's required to make: values are
lowercased and trimmed, because the device matches them as plain text
(`notes-app/src/lib/latex/corpus.ts`) and "Kubernetes" silently never matching
"kubernetes" would be a permanent miss on every future posting.

Direct unit tests on the module-level function, in the same spirit as
`test_clean_links_*` above — pure control flow, no need for a model call.
"""

from __future__ import annotations

from app.routers import resume


def test_an_empty_block_returns_a_valid_all_default_facets():
    facets = resume._facets({})
    assert facets == resume.TailorFacets(
        role_family="",
        seniority="",
        sector="",
        industry="",
        requirements=[],
    )


def test_a_non_list_requirements_field_is_treated_as_no_requirements():
    facets = resume._facets({"requirements": "kubernetes"})
    assert facets.requirements == []


def test_non_string_requirement_members_are_stringified_not_dropped_outright():
    # Every member is coerced to a string rather than the whole list being
    # rejected for one odd entry — a request that already cost minutes of
    # compute should not lose an otherwise-good facets block over this.
    facets = resume._facets({"requirements": ["kubernetes", 42, None, True]})
    assert facets.requirements == ["kubernetes", "42", "none", "true"]


def test_blank_and_whitespace_only_requirements_are_dropped():
    facets = resume._facets({"requirements": ["kubernetes", "", "   ", "go"]})
    assert facets.requirements == ["kubernetes", "go"]


def test_scalar_fields_are_lowercased_and_trimmed():
    facets = resume._facets(
        {
            "role_family": "  Full Stack Software Engineer  ",
            "seniority": "SENIOR",
            "sector": " Finance ",
            "industry": "Payments",
        }
    )
    assert facets.role_family == "full stack software engineer"
    assert facets.seniority == "senior"
    assert facets.sector == "finance"
    assert facets.industry == "payments"


def test_requirements_are_also_lowercased_and_trimmed():
    facets = resume._facets({"requirements": ["  Kubernetes ", "Distributed Systems"]})
    assert facets.requirements == ["kubernetes", "distributed systems"]


def test_non_string_scalar_fields_are_stringified_not_raised():
    facets = resume._facets({"role_family": 7, "seniority": None, "sector": True, "industry": []})
    assert facets.role_family == "7"
    assert facets.seniority == "none"
    assert facets.sector == "true"
    # An empty list stringifies to "[]", which is not blank, so it's kept as
    # given rather than silently dropped — _facets never raises, but it also
    # never invents a requirements-style "drop the empties" rule for scalars.
    assert facets.industry == "[]"


def test_a_completely_unrelated_block_shape_still_returns_valid_facets():
    """`block` on a pass that never asked for facets is whatever `_Written`
    defaulted it to, or leftovers from a different schema — never a reason to
    fail the request that's been waiting minutes for its resume."""
    facets = resume._facets({"latex": "\\documentclass{article}", "emphasis": "led a team"})
    assert facets == resume.TailorFacets()
