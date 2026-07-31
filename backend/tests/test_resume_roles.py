"""The job-title lookup behind the hardener.

Pure functions, no app and no network. What is worth testing here is almost
entirely the *reluctance*: `find_role` handing back a confidently wrong list of
qualifications is a failure nobody can see — the resume compiles, reads well, and
is built to satisfy the wrong screen — whereas handing back nothing falls through
to the model's own knowledge of the role and says so on screen.

So the negative cases below carry more weight than the positive ones, and two of
them are regressions: "Software Engineer" once matched the *intern* row (two words
of three shared), and "Backend Engineer" once matched the Java row through an
over-broad alias.
"""

from __future__ import annotations

import pytest

from app.resume_roles import (
    LEAD_MODIFIER,
    ROLES,
    find_role,
    is_lead,
    qualifications_for,
)


# --------------------------------------------------------------------------
# The table itself
# --------------------------------------------------------------------------


def test_every_row_finds_itself_by_its_own_title():
    """A row nothing can reach is a row that does not exist. Non-US rows are
    reachable only via their market, which their titles carry."""
    for role in ROLES:
        found = find_role(role.title)
        assert found is not None, f"{role.title!r} cannot be found by its own title"
        assert found.title == role.title


def test_every_alias_reaches_its_own_row():
    for role in ROLES:
        for alias in role.aliases:
            found = find_role(alias)
            assert found is not None, f"alias {alias!r} finds nothing"
            assert found.title == role.title, f"alias {alias!r} -> {found.title!r}"


def test_titles_are_unique():
    titles = [role.title for role in ROLES]
    assert len(titles) == len(set(titles))


def test_no_row_is_empty():
    for role in ROLES:
        assert role.qualifications.strip(), role.title


# --------------------------------------------------------------------------
# Matching what should match
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        # Exact.
        ("Data Analyst", "Data Analyst"),
        ("Product Manager", "Product Manager"),
        # Seniority is not a different screen.
        ("Senior Backend Java Developer", "Backend Java Developer"),
        ("Principal Site Reliability Engineer", "Site Reliability Engineer"),
        ("Junior Data Analyst", "Data Analyst"),
        ("Staff Machine Learning Engineer", "Machine Learning Engineer"),
        # Abbreviations and spellings.
        ("SWE Intern", "Software Engineer Intern"),
        ("ML Engineer", "Machine Learning Engineer"),
        ("front-end engineer", "Front End Software Engineer"),
        ("frontend developer", "Front End Software Engineer"),
        ("ui/ux designer", "UI/UX Designer"),
        ("sdet", "SDET (Software Test Engineer)"),
        ("C# Software Engineer", "C#/.NET Software Engineer"),
        ("helpdesk", "IT Support Specialist / Helpdesk"),
        ("sysadmin", "Systems Administrator"),
        # Case and punctuation are noise.
        ("  data   ENGINEER  ", "Data Engineer"),
    ],
)
def test_titles_that_should_match(query, expected):
    found = find_role(query)
    assert found is not None, f"{query!r} found nothing"
    assert found.title == expected


# --------------------------------------------------------------------------
# Refusing what should not match — the half that matters most
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "query",
    [
        # Nothing remotely in the table.
        "Underwater Basket Weaver",
        "Zookeeper",
        "",
        "   ",
        # Regression: shared "software engineer" is generic, and the row's own
        # word ("Embedded", "Intern") is what it is about. A generic query has no
        # row, and inventing one hands someone the wrong requirement list.
        "Software Engineer",
        "Engineer",
        "Developer",
        "Manager",
        "Analyst",
        # Regression: there is no generic backend row, and answering with Spring
        # and Hibernate would be a guess dressed as a reference.
        "Backend Engineer",
        # Regression: "Systems Engineer" was an alias of Embedded Software
        # Engineer, because the source row's title read "Embedded Software
        # Engineer / Systems Engineer". In the US market it is one of the
        # broadest titles there is — aerospace, telecom, networking, enterprise
        # IT — and answering it with RTOS, I2C and SPI is a firmware resume
        # handed to someone who has never written firmware.
        "Systems Engineer",
        "Systems Engineer II",
        "IT Systems Engineer",
        # Same class: a bare account manager is a sales role, not the post-sales
        # technical one; a bare scientist is not necessarily a lab scientist.
        "Account Manager",
        "Scientist",
    ],
)
def test_titles_that_should_not_match(query):
    assert find_role(query) is None


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ("Network Systems Engineer", "Network Engineer"),
        ("Cloud Systems Engineer", "Cloud Engineer (AWS)"),
    ],
)
def test_a_qualified_systems_title_still_reaches_the_row_it_qualifies(query, expected):
    """"Systems Engineer" alone has no row, but the word in front of it usually
    does — and that row is the right answer rather than a near miss. Guarding
    this because the fix for the embedded-alias bug was a rule about *narrower*
    candidates, and it would have been easy to write one that rejected these too.
    """
    found = find_role(query)
    assert found is not None, query
    assert found.title == expected


def test_a_narrower_row_never_answers_a_broader_query():
    """The rule the embedded bug turned on, stated directly.

    A candidate naming a real qualification the query didn't is a *different,
    narrower* job — "Embedded Software Engineer" for "Systems Engineer", or
    "Technical Account Manager" for "Account Manager". Both share most of their
    words with the query and both would be a confidently wrong requirement list.
    Filler nouns don't count, which is what keeps "front end engineer" reaching
    "Front End Software Engineer".
    """
    assert find_role("Systems Engineer") is None
    assert find_role("Account Manager") is None
    assert find_role("front end engineer").title == "Front End Software Engineer"


def test_the_embedded_row_is_still_reachable_by_saying_embedded():
    """Narrowing the aliases must not strand the row itself — the fix for an
    over-broad alias is easy to overshoot into an unreachable one."""
    for query in (
        "Embedded Software Engineer",
        "Embedded Systems Engineer",
        "Embedded Engineer",
        "Senior Embedded Software Engineer",
    ):
        found = find_role(query)
        assert found is not None, query
        assert found.title == "Embedded Software Engineer", query


def test_an_internship_is_a_different_screen_from_the_job():
    """The table keeps separate intern rows because they are screened for
    different things — "takes direction and criticism" is not a mid-career
    requirement, and the senior row's stack is not an intern's."""
    assert find_role("Data Analyst Intern").title == "Data Analyst Intern"
    assert find_role("Data Analyst").title == "Data Analyst"
    # And an intern query never falls through to the senior row of a title whose
    # intern row does not exist.
    assert find_role("Network Engineer Intern") is None
    assert find_role("Network Engineer").title == "Network Engineer"


# --------------------------------------------------------------------------
# Markets
# --------------------------------------------------------------------------


def test_a_plain_query_gets_the_us_row():
    """Otherwise "full stack engineer" is a three-way tie between the US,
    Canadian and EU rows, decided by declaration order."""
    assert find_role("Full Stack Software Engineer").region == "US"
    assert find_role("Python Software Engineer").region == "US"


def test_a_market_named_in_the_query_reaches_its_own_row():
    assert find_role("Full Stack Software Engineer Canada").region == "CA"
    assert find_role("Python Developer EU").region == "EU"
    assert find_role("Game Developer UK").region == "UK"


def test_an_unknown_title_in_a_named_market_falls_back_to_us_rows():
    """Naming a market must not make a title *harder* to find — the non-US rows
    are a handful, and someone in Canada applying for a Data Engineer job wants
    the Data Engineer list."""
    found = find_role("Data Engineer Canada")
    assert found is not None
    assert found.title == "Data Engineer"


# --------------------------------------------------------------------------
# The lead modifier
# --------------------------------------------------------------------------


def test_lead_is_detected_as_a_modifier_not_a_title():
    assert is_lead("Lead Data Engineer")
    assert not is_lead("Data Engineer")
    # A substring is not the word.
    assert not is_lead("Leadership Analyst")


def test_a_lead_title_gets_the_role_plus_the_leading():
    title, qualifications = qualifications_for("Lead Data Engineer")
    assert title == "Data Engineer"
    assert LEAD_MODIFIER in qualifications
    # The role's own qualifications are still all there.
    assert find_role("Data Engineer").qualifications in qualifications


def test_a_plain_title_gets_no_lead_modifier():
    _, qualifications = qualifications_for("Data Engineer")
    assert LEAD_MODIFIER not in qualifications


def test_qualifications_for_an_unknown_title_is_none():
    assert qualifications_for("Underwater Basket Weaver") is None
