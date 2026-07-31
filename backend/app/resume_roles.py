"""What a job title is actually screened for, per title.

A recruiter's reference table: for each job title, the qualifications a US hiring
manager asks for and a recruiter screens against. It exists because of the step
the resume guide (`resume_guide.py`) says matters most and is the hardest for one
person to do — before writing a word, go and read ten to fifteen postings for the
same job title, write down every qualification, and count how often each appears.
That list is what the resume is then built to evidence. This file is that work,
already done, for the titles it covers.

Two endpoints use it, and they use it differently:

- **`/resume/harden`** has nothing else. Its only input is a job title, so this
  table *is* the requirement list, and a title with no row here falls back to the
  model's own knowledge of the role (and says so, so nobody thinks a reference
  was consulted when it wasn't).
- **`/resume/tailor`** has a real posting, which always wins — a specific job's
  requirements beat a general title's. The row goes in as a **cross-check**: the
  qualifications this title is usually screened for, so something the person
  genuinely has doesn't get left benched merely because this particular posting
  buried it.

## On matching

`find_role` is deliberately reluctant. Injecting the wrong role's qualifications
is worse than injecting none — the fallback is a model that knows roughly what a
"Sales Engineer" needs, whereas a bad match hands it a confident, specific, wrong
list and it has no way to tell. So seniority words are stripped ("Senior Backend
Engineer" and "Backend Engineer" are the same screen), exact and alias matches are
taken first, and a fuzzy match has to clear a real threshold before it counts.

## On the data

Transcribed as written, in the recruiter's own shorthand, because the shorthand is
the point: "Cloud and it's words (EC2)" means *name the specific services*, and a
tidied "cloud platform experience" would lose that. Everything is the US market
unless a row says otherwise; region-specific rows are kept as their own entries
and are only matched when the query asks for that region.

Three editorial calls, all made to keep lookups unambiguous:

- Titles that appeared twice in the source with different notes (embedded, DevOps,
  research scientist) are merged into one row holding the union.
- One source row had its title column empty and its qualifications duplicated into
  it; from its content it is a technical partner/vendor manager, and it is entered
  under that name.
- One row was a placeholder listing other rows ("Random Software Engineer") and is
  not a role, so it is not here.
- One row is not a job title at all but a modifier — what changes about *any*
  role's screen when it is a lead position — and it is applied on top of a matched
  role rather than being matchable itself. See `LEAD_MODIFIER`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Role:
    """One job title and what it is screened for."""

    title: str
    qualifications: str
    #: Other names the same screen goes by, normalised the same way as `title`.
    aliases: tuple[str, ...] = field(default=())
    #: "US" unless the source row was explicitly for another market. Non-US rows
    #: only match when the query names that market.
    region: str = "US"


#: Not a role. What additionally gets screened for when a role is a lead one —
#: added on top of whatever role matched, when the title says "lead".
LEAD_MODIFIER = "cross-functional, leading as an IC, work with Stakeholders"


ROLES: tuple[Role, ...] = (
    # ---- Software engineering -------------------------------------------
    Role(
        title="Software Engineer Intern",
        qualifications=(
            "Degree\n"
            "Basic knowledge of Tech Stack (Language, SQL, Cloud, AI, object-oriented programming).\n"
            "Ability to work with others\n"
            "Takes direction and criticism"
        ),
        aliases=("swe intern", "software engineering intern", "software developer intern"),
    ),
    Role(
        title="Embedded Software Engineer",
        qualifications=(
            "Degree\n"
            "C/C++, Linux, Python, Shell Scripting\n"
            "TCP/IP, UART, SPI, I2C, Real Time Operating System (RTOS)\n"
            "Embedded Systems Development Tools\n"
            "Certs (ISO), Clearance, debug system\n"
            "Type of Industry and what you are working on (i.e. Aerospace Engines)\n"
            "Explain technical topics to non-technical people, Git\n"
            "Cross Functional\n"
            "Ability to work with others, takes direction and criticism"
        ),
        # Every alias says "embedded". A bare "Systems Engineer" must **not**
        # reach this row: in the US market that title is one of the broadest
        # there is — aerospace, defence, telecom, networking, enterprise IT —
        # and almost none of it is firmware. Handing that person RTOS, I2C and
        # SPI as their requirement list is the exact failure this module exists
        # to avoid, and it is worse here than for most rows because the source
        # row's own title carried "/ Systems Engineer" and made the alias look
        # justified.
        aliases=(
            "embedded systems engineer",
            "embedded engineer",
            "embedded software systems engineer",
        ),
    ),
    Role(
        title="C#/.NET Software Engineer",
        qualifications=(
            "C#/.NET, SQL, .NET Core\n"
            "Azure, Git, Agile, RESTful API\n"
            "DevOps, CI/CD, Git\n"
            "ASP.NET\n"
            "Nice to Have: Full Stack (TypeScript, JavaScript, React, Angular), Microservices, Kubernetes"
        ),
        aliases=("c# developer", "dotnet developer", "net developer", "c# engineer"),
    ),
    Role(
        title="Python Software Engineer",
        qualifications=(
            "Python, SQL (any), Docker\n"
            "Cloud, RESTful APIs/REST APIs\n"
            "Git, CI/CD\n"
            "AI: ML, Agentic, etc, and its specific tools (LangGraph for MAS) OR Fullstack (JavaScript, HTML5, CSS3)\n"
            "Nice to Have: FastAPI, Flask, or Django"
        ),
        aliases=("python swe", "python developer", "python engineer"),
    ),
    Role(
        title="Python Software Engineer (EU)",
        qualifications=(
            "Python, SQL (any), Docker, Kubernetes, Django, Flask\n"
            "Cloud and it's words (AWS/GCP/Azure)\n"
            "RESTful/FAST APIs\n"
            "Git, CI/CD\n"
            "Bonus: Full Stack, DevOps, MLOps, Object-Oriented Programming, MultiThreading"
        ),
        aliases=("python swe eu", "python developer eu"),
        region="EU",
    ),
    Role(
        title="Python Developer (India)",
        qualifications=(
            "Python, (NumPy, pandas, Fast API)\n"
            "MongoDB, AI/ML/LLM, SQL\n"
            "Cloud, CI/CD, Git, REST API\n"
            "Kubernetes, Docker, Django, Agile\n"
            "Bonus: Full Stack"
        ),
        aliases=("python swe india",),
        region="IN",
    ),
    Role(
        title="Backend Java Developer",
        qualifications=(
            "Java, Spring, Springboot, Maven\n"
            "SDLC, SQL, RESTful API or REST APIs, Microservices, CI/CD\n"
            "object-oriented programming (OOP)\n"
            "Git, Linux/Unix, Agile/Scrum\n"
            "Cloud, Architecting or Systems\n"
            "Hibernate, Docker, Kubernetes, Kafka\n"
            "Rare but nice to have: Full Stack (JavaScript, React, Angular, Vue), DevOps, RabbitMQ, AI"
        ),
        # Every alias names Java. A bare "Backend Engineer" must *not* reach this
        # row — there is no generic backend row in the table, and answering a
        # generic question with Spring and Hibernate is exactly the confidently
        # wrong list `find_role` exists to avoid.
        aliases=("java developer", "java engineer", "java software engineer"),
    ),
    Role(
        title="Go/Node.js Engineer",
        qualifications=(
            "Degree, Agile\n"
            "Go/Golang, Fiber Node.JS, Nest.js, SQL, MongoDB, Redis\n"
            "Cloud, CICD, Git, Kafka, RabbitMQ\n"
            "Docker, Kubernetes\n"
            "Extra Language: C#, C++, Java, etc\n"
            "OOP"
        ),
        aliases=("go developer", "golang engineer", "golang developer", "node js developer"),
    ),
    Role(
        title="Ruby on Rails Developer",
        qualifications=(
            "Ruby on Rails\n"
            "TypeScript, JavaScript, CSS, HTML (for Full Stack Roles)\n"
            "Node.js, Next.js, GraphQL\n"
            "SQL, React JS, API, RESTful API\n"
            "Cloud, Agile, CI/CD, Redis\n"
            "Git/GitHub\n"
            "Bonus: MVC, RabbitMQ"
        ),
        aliases=("ruby developer", "rails developer", "ruby on rails engineer"),
    ),
    Role(
        title="Full Stack Software Engineer",
        qualifications=(
            "Degree\n"
            "TypeScript, JavaScript, HTML, CSS\n"
            "RESTful API or REST API\n"
            "SQL (Any), Cloud (AWS, GCP, Azure)\n"
            "Back End (Python, C#/NET, Java)\n"
            "React or React Native\n"
            "Git or GitHub\n"
            "CI/CD, Agile, DevOps\n"
            "Extra Credit: AI Tools, Number of Users if you Built the Infrastructure, Cross-Functional\n"
            "Development tools (e.g., Claude, Cursor, GitHub Copilot, etc.)"
        ),
        aliases=("full stack engineer", "full stack developer", "fullstack software engineer"),
    ),
    Role(
        title="Full Stack Software Engineer (Canada)",
        qualifications=(
            "TypeScript, Python, JavaScript, CSS, HTML, React, and Vue.js\n"
            "Node, Angular, NextJS (MongoDB)\n"
            "SQL, API, Rest, GraphQL\n"
            "Cloud, Agile CI/CD, cross-functionally\n"
            "Bonus Points: architecture, Extra language, Git, AI/LLM, DevOps, Django, Flask, Kubernetes"
        ),
        region="CA",
    ),
    Role(
        title="Full Stack Software Engineer (EU)",
        qualifications=(
            "TypeScript, JavaScript, CSS, HTML\n"
            "Java, Spring Boot, Microservices\n"
            "Python, Django, Docker\n"
            "Node, Angular, Next.js\n"
            "SQL, React, API, Rest, Git\n"
            "Cloud, Agile CI/CD, cross-functionally\n"
            "Bonus Points: architecture, Extra language, Git"
        ),
        region="EU",
    ),
    Role(
        title="Front End Software Engineer",
        qualifications=(
            "Degree, Portfolio\n"
            "React, TypeScript, JavaScript, HTML, CSS\n"
            "UI/UX, Angular, Next.js, Nuxt.js, or Node.js\n"
            "REST APIs or API, AI\n"
            "Owned the Process from 0 to 1\n"
            "Communicate clearly with designers and product managers about what's feasible and what isn't\n"
            "Extra Credit: SDKs, Vue, Scrum/Agile, Backend Language"
        ),
        aliases=("front end engineer", "front end developer", "frontend software engineer"),
    ),
    Role(
        title="Front End Software Engineer (EU)",
        qualifications=(
            "React, JavaScript, AngularJS, HTML, CSS\n"
            "SQL, Scrum/Agile, RESTful APIs\n"
            "WordPress, Git\n"
            "Vue, Next\n"
            "Bonus: Extra language, Cloud, UI/UX, TypeScript, DevOps"
        ),
        region="EU",
    ),
    Role(
        title="Mobile Software Developer",
        qualifications=(
            "React or React Native\n"
            "iOS (Swift, SwiftUI) Android (Java, Kotlin)\n"
            "MVVM, Flutter, Agile\n"
            "JavaScript, TypeScript\n"
            "RESTful APIs, Redux, GraphQL\n"
            "Working in a collaborative environment\n"
            "If C# (MAUI or Xamarin)\n"
            "Next.js\n"
            "Bonus: SDKs, Play Store, App Store"
        ),
        aliases=("mobile developer", "mobile engineer", "mobile software engineer"),
    ),
    Role(
        title="iOS Developer",
        qualifications=(
            "Swift/Objective-C/SwiftUI\n"
            "REST API, REST, React\n"
            "mobile architectures\n"
            "HTML5, CSS3, JavaScript, React, and TypeScript\n"
            "Git, Agile, CI/CD\n"
            "Cloud\n"
            "MVVM, MVC"
        ),
        aliases=("ios engineer", "ios software engineer"),
    ),
    Role(
        title="Android Developer",
        qualifications=(
            "Degree\n"
            "Android, Kotlin, Android SDK\n"
            "MVVM/MVI, Git, UI\n"
            "Jetpack Compose, RESTful APIs, Cross-Functional\n"
            "(Hilt, Dagger), scale of product\n"
            "Architecture\n"
            "Some of these, but not all: Flutter, BackEnd Language (Java), AI, CI/CD, Restful API"
        ),
        aliases=("android engineer", "android software engineer"),
    ),
    Role(
        title="Game Developer (UK)",
        qualifications=(
            "Server Side: Cloud, Matchmaking, Server Orchestration, CI/CD, DevOps, API, SQL, Python, Docker, Kubernetes\n"
            "Game Engine: 3D Math/Animation, Unreal, physics systems, debug and resolve complex\n"
            "Both: C++/C#, Networking, Shipped Projects, Multitask on a Deadline, Cross-functional"
        ),
        aliases=("games developer", "game engineer"),
        region="UK",
    ),
    Role(
        title="Salesforce Developer",
        qualifications=(
            "Degree, Certs\n"
            "Salesforce, Industry\n"
            "APEX, Triggers, Lightning Web Components (LWC), Flow, SOQL/SOSL\n"
            "Reports/Dashboards, JavaScript\n"
            "Cloud, Agile, Jira\n"
            "Salesforce architecture, RESTful APIs OR Rest APIs, and integrations\n"
            "Explain complex tech to non-tech audience\n"
            "Microsoft 365 Applications/Suite\n"
            "MuleSoft, DevOps, CI/CD"
        ),
    ),
    Role(
        title="ServiceNow Developer",
        qualifications=(
            "B.A./HighSchool/GED\n"
            "JavaScript, HTML, CSS, XML\n"
            "SQL, REST/SOAP APIs\n"
            "ITIL, ServiceNow Developer or (CSA)\n"
            "Certs: CSA, Implementation\n"
            "CMDB, HAM, SAM etc.\n"
            "Industry, ITIL\n"
            "Extra Credit: ETL, GRC/IRM, Cloud\n"
            "Agile/Scrum"
        ),
    ),
    Role(
        title="SDET (Software Test Engineer)",
        qualifications=(
            "Degree\n"
            "testing methodologies (functional, usability, end-to-end, regression, backend testing)\n"
            "Database testing/SQL\n"
            "Agile/Scrum, CI/CD, Git, Jenkins\n"
            "Communicate bugs to developers and other stakeholders\n"
            "WHAT ARE YOU TESTING AND IT's KEYWORDS such as the following\n"
            "Coding Language, TestRail, Azure DevOps, Jama\n"
            "frameworks/tools such as: UI: Playwright / Cypress / Selenium and API: pytest + requests, Postman/Newman"
        ),
        aliases=(
            "sdet",
            "software test engineer",
            "qa engineer",
            "quality assurance engineer",
            "test engineer",
            "software engineer in test",
        ),
    ),
    # ---- AI, ML, data ----------------------------------------------------
    Role(
        title="AI Engineer",
        qualifications=(
            "Degree, Python (or other backend), ML, LLMs\n"
            "Cloud (GCP, Azure, AWS), Built stuff in Production, Agentic Systems/Multi-Agent\n"
            "Agentic Coding: Claude Code, Open AI Codex, Cursor\n"
            "Frameworks: LangGraph, LangChain, Google ADK, Open AI Agent SDK\n"
            "Communicate technical details to a non-technical audience\n"
            "MLOps: AI Architectures, AI Orchestration\n"
            "Rare: Industry, SQL, RAG, Git, NumPy (etc)"
        ),
        aliases=("ai software engineer", "genai engineer", "llm engineer"),
    ),
    Role(
        title="AI Engineer Intern",
        qualifications=(
            "Degree\n"
            "Basic SWE: Python, TypeScript, JavaScript, React, SQL, Git, Cloud, APIs\n"
            "Basic AI: AI, ML, RAG, GenAI, Agentic AI, AI/ML, AI Tools (ChatGPT, Claude, or GitHub Copilot), LangGraph or LangChain\n"
            "Explain technical concepts to non-technical people.\n"
            "Take direction and criticism, work well with others"
        ),
    ),
    Role(
        title="AI Developer",
        qualifications=(
            "LLM, AI/ML/NLP, PyTorch, Tensorflow\n"
            "Cloud, Hugging Face, Python\n"
            "Company Specific (Chat bot, Industry, UI/UX)"
        ),
    ),
    Role(
        title="Machine Learning Engineer",
        qualifications=(
            "Degree, Machine Learning (ML)\n"
            "Cloud, CI/CD, DataBricks, Git\n"
            "SQL, Python (Java/C#/.NET)\n"
            "Cross-functional and can communicate technical details to non-technical people.\n"
            "ML Frameworks/Libraries: TensorFlow, PyTorch, scikit-learn, Pandas, NumPy\n"
            "The scale of the systems you have built (non-technical)\n"
            "training, tuning, and deploying models in production environments from 0 to 1"
        ),
        aliases=("ml engineer", "machine learning developer"),
    ),
    Role(
        title="Machine Learning Intern",
        qualifications=(
            "Machine Learning (ML)\n"
            "Python, C/C++, SQL\n"
            "Pytorch, Tensorflow, Cloud\n"
            "LLM, AI, Generative AI, Chat GPT\n"
            "Take direction and criticism, work well with others\n"
            "Degree"
        ),
        aliases=("ml intern",),
    ),
    Role(
        title="Data Engineer",
        qualifications=(
            "Python, ETL/ELT\n"
            "SQL, Cloud + S3 (or equivalent)\n"
            "Data X (models, lakes, etc)\n"
            "Ability to manage and communicate data plans to a non-technical, Meet multiple deadlines\n"
            "Big Data (Kafka, Spark, Hadoop), Git\n"
            "Industry: SDLC, etc\n"
            "Rare: Tableau, Power BI, AI/ML, BigQuery, Snow. CI/CD"
        ),
    ),
    Role(
        title="Analytics Engineer",
        qualifications=(
            "Degree\n"
            "SQL, Databricks, PySpark, Data Engineering\n"
            "SDLC, building, testing, coding, Python\n"
            "Cloud, BI Tools/Data Visualization tools (Tableau, Looker, Power BI)\n"
            "AI, CI/CD, Large Data Sets, Cloud, Database Managment Systems (MongoDB, Microsoft SQL)\n"
            "ability to collaborate with both technical and non-technical stakeholders.\n"
            "Extra Credit: ETL, ELT, R, data governance"
        ),
    ),
    Role(
        title="Data Scientist",
        qualifications=(
            "Degree\n"
            "Python or R, SQL\n"
            "Industry (Healthcare, SDLC, etc), explain stuff to non-technical folks, Influence Stakeholders, Cross Functional\n"
            "ML Ops\n"
            "Microsoft Office applications (Word, Excel, PowerPoint), Google Sheets\n"
            "Dashboards/Data Visualization (Power BI)\n"
            "Extra Credit: Using AI and working with it, Data in all it's forms (Modeling, Analytics, etc)"
        ),
    ),
    Role(
        title="Data Science Intern",
        qualifications=(
            "Degree\n"
            "Python, Java, or R, OOP\n"
            "ML/AI, LLM, Cloud, (maybe a library or two as well), RESTful API, Git\n"
            "SQL, Excel, Tableau\n"
            "Communicate Tech to non-tech people\n"
            "Work well with others and take criticism\n"
            "Bonus: HTML, CSS, JavaScript, CI/CD"
        ),
    ),
    Role(
        title="Data Analyst",
        qualifications=(
            "Degree, Industry\n"
            "SQL, data visualization (Tableau, Power BI, Looker)\n"
            "Influence Stakeholders, explaining technical concept to nontechnical stakeholders\n"
            "How you solved a problem with Data not what the data is\n"
            "MS Excel (macros, pivot tables, VLOOKUP), Word\n"
            "Python, R, Multiple Projects, and deadlines\n"
            "Nice to Have: Cloud, AI, Security Clearance"
        ),
    ),
    Role(
        title="Data Analyst Intern",
        qualifications=(
            "Degree\n"
            "Basic knowledge of Data Analyst (SQL, Python, Tableau, Excel, MS Office, PowerPoint).\n"
            "Ability to work with others\n"
            "Takes direction and criticism"
        ),
    ),
    Role(
        title="Data Analytics Intern",
        qualifications=(
            "Degree\n"
            "Basic knowledge of SQL, Python data tools (Pandas, NumPy, or similar), Excel (VBA, Macros, Pivot Tables)\n"
            "Ability to work with others\n"
            "Takes direction and criticism"
        ),
    ),
    Role(
        title="Business Intelligence Analyst",
        qualifications=(
            "Degree\n"
            "SQL, ETL (Data Warehouse)\n"
            "Tableau, Power BI, Data Visualization, QlikView, MS Office, Excel\n"
            "Ability to talk with customers/stakeholders and explain complex topics to them\n"
            "Industry Specific (Education, Healthcare, etc)\n"
            "Bonus: Python, R, AI/NLP"
        ),
        aliases=("bi analyst",),
    ),
    Role(
        title="Business Intelligence Analyst (Canada)",
        qualifications=(
            "Degree\n"
            "SQL, AI\n"
            "Tableau, Power BI, Data Visualization, MS Office, Excel (Pivot Tables/VLookup)\n"
            "Ability to talk with customers/stakeholders and explain complex topics to them\n"
            "Industry Specific (Education, Healthcare, etc)\n"
            "Bonus: Python, R, SAP, French/English"
        ),
        region="CA",
    ),
    Role(
        title="Business Intelligence Engineer",
        qualifications=(
            "Degree\n"
            "Data Visualization Tools (Looker, Power BI)\n"
            "SQL, DBT, Python, R, Shell scripting\n"
            "dimensional models\n"
            "Explained complex topics to non-tech folk (WHAT you used the data for NOT how you got it)\n"
            "Microsoft Excel for data validation\n"
            "Cross Functional, Agile/Scrum/Kanban etc\n"
            "Nice to Have: DAX, ETL"
        ),
        aliases=("bi engineer",),
    ),
    Role(
        title="HR Data Analyst",
        qualifications=(
            "Degree, Industry (HRIS, UKG Ready, ADP, Workday, Paycom)\n"
            "SQL, data visualization (Tableau, Power BI, Looker)\n"
            "Stakeholders, explaining technical concept to nontechnical stakeholders\n"
            "Policies and Law\n"
            "MS Excel (macros, pivot tables, VLOOKUP), Word\n"
            "Multiple Projects and deadlines"
        ),
        aliases=("people analytics analyst",),
    ),
    Role(
        title="Supply Chain Analyst",
        qualifications=(
            "Supply Chain, Operations, Finance, Data Heavy experience\n"
            "MS Office (Advanced Excel, Word, Outlook, Powerpoint)\n"
            "Data Visualization (Looker, Power BI)\n"
            "Dbt, Snowflake, Big Query\n"
            "ERP systems (SAP/Oracle/Tableau), SAP\n"
            "Cross Functional\n"
            "complex data clearly to non-technical people\n"
            "Bonus: APIC, CPIM, CSCP, Six Sigma"
        ),
    ),
    Role(
        title="Quantitative Developer",
        qualifications=(
            "Degree\n"
            "Python/Java (pandas, Numpy, Scipy, Matplotlib), SQL\n"
            "real-world datasets and building reproducible analyses or pipelines.\n"
            "data engineering (Airflow, Snowflake, polars workflows)\n"
            "Cloud, AWS, Docker, CI/CD\n"
            "ML Ops, real-time and/or historical market data, or other high volume time series data.\n"
            "stakeholder management, trading, WHAT you used the data for"
        ),
        aliases=("quant developer",),
    ),
    Role(
        title="Quantitative Researcher",
        qualifications=(
            "BS with 2+ years or MS or PHD\n"
            "Python (Pandas, NumPy), C++, R, SQL\n"
            "Algorithmic trading research, Data Analysis\n"
            "Quantitative finance concepts and methodologies\n"
            "Communicate technical details to a non-tech audience\n"
            "Pro-actively solve problems with Math\n"
            "Machine Learning (ML)\n"
            "Extra Credit: market microstructure, forecasting"
        ),
        aliases=("quant researcher",),
    ),
    Role(
        title="Actuarial Analyst",
        qualifications=(
            "Degree\n"
            "Actuarial Exams completed\n"
            "Actuarial Modeling, Data Analysis, Analyzing Large Datasets\n"
            "Solve problems with Data\n"
            "SQL, Power BI, Excel, MS Office\n"
            "Explain complex technical data to non-technical stakeholders\n"
            "Work together as a team\n"
            "Industry (Healthcare, Insurance, etc)"
        ),
    ),
    # ---- Infrastructure, cloud, security ---------------------------------
    Role(
        title="DevOps Engineer",
        qualifications=(
            "DevOps, Cloud, and its words (EC2)\n"
            "CI/CD, GitHub Actions, Jenkins, GitLab CI/CD, Azure DevOps\n"
            "Coding Language (Python, Java, etc), PowerShell, Bash, Ruby\n"
            "Linux, Unix\n"
            "Infrastructure as Code (IaC)\n"
            "Kubernetes, Docker, Terraform, Helm, Ansible, CloudFormation\n"
            "Monitoring Platforms: Prometheus, Grafana, or DataDog\n"
            "monitoring and logging, caching, scaling and parallelization\n"
            "Troubleshoot, SQL, GitHub, Multitask multiple projects\n"
            "network protocols, firewall management, and security\n"
            "Bonus: AI, Databricks, Industry"
        ),
        aliases=("devops", "platform engineer"),
    ),
    Role(
        title="DevOps Intern",
        qualifications=(
            "Degree\n"
            "Basic knowledge of DevOps (Git, CI/CD, Cloud, Linux/Unix, SDLC, Infrastructure as Code (IaC), Terraform, Docker, Backend Language).\n"
            "Ability to work with others\n"
            "Takes direction and criticism"
        ),
    ),
    Role(
        title="Site Reliability Engineer",
        qualifications=(
            "Degree\n"
            "Cloud (and it's stuff EC2), Collaborated with stakeholders (Internal/External)\n"
            "DataDog\n"
            "Infrastructure as Code (IaC), Terraform, Helm\n"
            "CI/CD, GitHub, Python, Go, and Node.js, DevOps, Docker\n"
            "Linux/Windows"
        ),
        aliases=("sre", "reliability engineer"),
    ),
    Role(
        title="Cloud Engineer (AWS)",
        qualifications=(
            "Degree\n"
            "AWS, Python or Bash, CI/CD, Agile or Scrum\n"
            "SQL, Linux, Windows, Excel, GitHub\n"
            "Infrastructure as Code (IAC): Terraform or CloudFormation\n"
            "CloudWatch, Kubernetes\n"
            "Explain complex topics and talk with non-technical stakeholders\n"
            "troubleshooting, monitoring, and optimizing cloud environments\n"
            "Certs"
        ),
        aliases=("cloud engineer", "aws engineer", "aws cloud engineer"),
    ),
    Role(
        title="Cloud Engineer (Canada)",
        qualifications=(
            "Cloud and it's stuff (EC2)\n"
            "IAM, Infrastructure-as-Code (e.g. Pulumi, Terraform)\n"
            "Python, Bash, shell scripting\n"
            "CI/CD\n"
            "VPCs, DNS, security groups, routing, gateways, Firewalls\n"
            "Kubernetes, OpenShift, Docker, Terraform, Datadog\n"
            "DevOps, Cloud Engineer"
        ),
        region="CA",
    ),
    Role(
        title="Cloud Architect (Azure)",
        qualifications=(
            "Degree\n"
            "DevOps, CI/CD, GitHub Actions, Microsoft 365\n"
            "Azure (Landing Zones, Core, Arc, Migrate, etc)\n"
            "Communicated complex ideas to non-technical stakeholders/customers\n"
            "Microsoft certifications\n"
            "PowerShell, Infrastructure as Code (IaC)\n"
            "Bonus: Bicep/ARM/Terraform"
        ),
        aliases=("cloud architect", "azure architect"),
    ),
    Role(
        title="Systems Administrator",
        qualifications=(
            "Linux/Mac/Windows, Cloud\n"
            "DNS, DHCP, TCP/IP, VPN\n"
            "managing system hardware/software and automating tasks, Active Directory\n"
            "Infrastructure as Code (IaC), Office 365\n"
            "troubleshooting, and multitasking\n"
            "Python, API, CI/CD, Bash, Powershell\n"
            "Ticketing System (Jira), ISO"
        ),
        aliases=("sysadmin", "system administrator"),
    ),
    Role(
        title="Network Engineer",
        qualifications=(
            "Routing, switching, firewalls, VLANs, VPNs, WLAN, and core network protocols (TCP/IP, DNS, DHCP)\n"
            "IPv4, IPv6, BGP/IPSec\n"
            "Palo Alto Networks firewalls (PAN-OS, GlobalProtect, WildFire, etc.)\n"
            "VMware Certified Professional - NSX (VCP-NV) / CCNP, CCDP Cert\n"
            "WAN/LAN, Cisco\n"
            "Routing/Switching Protocols: BGP, OSPF, and MPLS"
        ),
    ),
    Role(
        title="IT Support Specialist / Helpdesk",
        qualifications=(
            "MacOS/Linux, Android, Windows (7-11)\n"
            "Education, Customer Service, Troubleshooting/problem solving\n"
            "Explain tech to non-tech audience\n"
            "Networking: DNS, DHCP, TCP/IP, VPN\n"
            "Multitask and meet deadlines\n"
            "Industry (Azure, LAN/WAN, CRM)\n"
            "Jira, Office/Microsoft 365, Active Directory, Slack, Zendesk\n"
            "Bonus: CompTIA A+, Microsoft Certified Desktop Support, PowerShell"
        ),
        aliases=(
            "it support specialist",
            "helpdesk",
            "help desk",
            "it helpdesk",
            "it support",
            "desktop support",
        ),
    ),
    Role(
        title="Desktop Engineer",
        qualifications=(
            "Windows (10/11), Microsoft/MS 365 stack (Entra ID, Intune, Exchange)\n"
            "Word, Excel, Outlook, Troubleshooting\n"
            "DNS, DHCP, TCP/IP, and VPN\n"
            "Multitask while meeting all deadlines, customer service\n"
            "produce clear technical documentation and ticket notes that another engineer can act on\n"
            "Explain complex technical details for non-technical people"
        ),
    ),
    Role(
        title="SOC Analyst",
        qualifications=(
            "Degree, Cybersecurity, SOC, NOC\n"
            "Certs (CSSP, CompTia, Cloud, etc)\n"
            "Troubleshooting/Diagnostic\n"
            "PowerShell, Python, Power BI, etc.), SIEM\n"
            "DoD Security Clearance\n"
            "Intrusion Detection & Prevention Systems (IDS/IPS), Firewalls & Log Analysis, Network Behavior Analysis tools, Antivirus\n"
            "security analysis, malware investigations, and forensic methodologies.\n"
            "Diamond Model, NIST Incident Response\n"
            "Nice to Have: ISSO, ISSM, Excel"
        ),
        aliases=("security operations center analyst",),
    ),
    Role(
        title="Cybersecurity Analyst",
        qualifications=(
            "Degree, Industry and Clearance (DoD, Military, ISO, HIPPA, etc)\n"
            "Certifications: CompTIA Security+, CEH, CISSP, OSCP, GIAC\n"
            "Python, SIEM tools, threat detection, and incident response\n"
            "Can communicate security risks clearly to non-technical stakeholders\n"
            "Extra Credit: MITRE ATT&CK, Cloud"
        ),
        aliases=("security analyst", "information security analyst"),
    ),
    Role(
        title="Cybersecurity Engineer",
        qualifications=(
            "Degree, Python, PowerShell, SOC\n"
            "CISSP, CISM, CEH, CompTIA Security\n"
            "protocols, systems, and methodologies\n"
            "firewalls, IDS/IPS, SIEM, anti-virus software, and vulnerability management\n"
            "Cisco FirePower/FMC, Cisco Umbrella, Cisco Secure Client (including VPN) and Cisco XDR\n"
            "SOC2, PCI-DSS, NIST, CIS and ISO\n"
            "WAN, LAN, Active Directory, Windows, MacOS, Android\n"
            "Explain complex topics to non-technical stakeholders"
        ),
        aliases=("security engineer",),
    ),
    Role(
        title="Cybersecurity Intern",
        qualifications=(
            "Degree\n"
            "Basic knowledge of Cybersecurity/IT Support: MS Office, Networking, Cybersecurity Principles, Phishing, Malware, Windows, presentations\n"
            "Ability to work with others\n"
            "Takes direction and criticism"
        ),
        aliases=("security intern",),
    ),
    Role(
        title="Penetration Tester",
        qualifications=(
            "Cybersecurity or Penetration Tester (sysadmin, infrastructure, net-engineering, software development, and security-engineer experience)\n"
            "Blue Team, write exploits from scratch\n"
            "BloodHound, Mimikatz, Metasploit, Cobalt Strike\n"
            "Windows and Linux internals, DNS, SMB, LDAP, and Kerberos\n"
            "Kali, Linux, Burp Suite, Metasploit, Nessus\n"
            "Python, PowerShell, Bash\n"
            "Bonus: OSCP, CEH, or GPEN"
        ),
        aliases=("pentester", "offensive security engineer"),
    ),
    Role(
        title="GRC Analyst",
        qualifications=(
            "GRC/Security/Compliance\n"
            "SOC or ISO or HIPPA\n"
            "Cloud and it's cert\n"
            "AI governance, Cross Functional\n"
            "NIST, CIS, Audit\n"
            "Microsoft tools (Excel, SharePoint, Word)\n"
            "Navigating Documentation\n"
            "Speaking to non-technical teams/stakeholders"
        ),
        aliases=("governance risk and compliance analyst", "compliance analyst"),
    ),
    # ---- Product, program, project ---------------------------------------
    Role(
        title="Product Manager",
        qualifications=(
            "Degree, Industry (B2B, SaaS, etc)\n"
            "Influenced people at all levels of the company\n"
            "analyze user data and extract business requirements from stakeholders and transform them into product requirements.\n"
            "Change the company through data-driven decisions\n"
            "Agile/Scrum, Cross-Functional\n"
            "0 to 1, how you moved teams faster and pro-actively solved problems\n"
            "HOW you succeeded and the RESULT of that success (NOT BRAG)\n"
            "Tools: Jira, Azure DevOps, Confluence, Microsoft Teams, Figma, MS Office"
        ),
    ),
    Role(
        title="Product Manager Intern",
        qualifications=(
            "Degree\n"
            "Work Cross Functionally, explain complex technical topics to non-technical people, product tech (Cloud, AI, etc), Industry, Fast moving environment, leadership\n"
            "Ability to work with others\n"
            "Takes direction and criticism"
        ),
    ),
    Role(
        title="Technical Product Manager",
        qualifications=(
            "Degree, Scrum Master (CSM) or PMP\n"
            "Agile, How you solved problems with People/Tools/Tech\n"
            "Agile project management tools (e.g., Jira, Asana)\n"
            "collaborating closely with technical teams and stakeholders and INFLUENCING THEM\n"
            "Triaging, multitasking\n"
            "Industry Keywords: DevOps, SDLC, etc"
        ),
        aliases=("tpm",),
    ),
    Role(
        title="Product Owner",
        qualifications=(
            "Agile, JIRA\n"
            "Spark, Databricks, React, Python, SPAs, microservices, and API integrations\n"
            "Industry, Confluence\n"
            "product delivery, project ownership, or technical product\n"
            "Cross Functional, influence internal/external stakeholders\n"
            "Multitask"
        ),
    ),
    Role(
        title="Project Manager",
        qualifications=(
            "Details about HOW AND WHY you did X\n"
            "How you made things happen compared to how you did things\n"
            "PMP/CSM, Customers/Stakeholders, Agile\n"
            "Industry\n"
            "# team members, matrixed/cross-functional\n"
            "Number of projects/Budget, Multitask\n"
            "How did you use resources for success\n"
            "How you solved problems/Influence\n"
            "Jira, Confluence, MS Project, Asana, Monday, Microsoft Suite"
        ),
    ),
    Role(
        title="Technical Program Manager",
        qualifications=(
            "Degree\n"
            "Managing Projects, # of projects, people, you led. 0 to 1 (project lifecycle)\n"
            "How you influenced stakeholders and the business reason you did so\n"
            "Can manage and speak to technical and non-technical people\n"
            "Tech knowledge: AI/ML, etc\n"
            "tools (e.g. Jira, Confluence, Smartsheet, MS Project, or similar)\n"
            "Agile, Cross Functional, Certs"
        ),
    ),
    Role(
        title="Program Manager",
        qualifications=(
            "Industry, PMP, Microsoft Project and Visio, Microsoft 365\n"
            "MS Office (Word, Excel, PowerPoint/pivot tables)\n"
            "cross functional highly matrixed organization, stakeholders, customers, clients, Agile\n"
            "How you succeeded and managed multiple projects at the same time"
        ),
    ),
    Role(
        title="Project Coordinator",
        qualifications=(
            "Degree or HS Diploma\n"
            "Project Coordination Experience\n"
            "Multitask while meeting deadlines\n"
            "Pro-active problem solving\n"
            "Industry, communicate to all levels of the company\n"
            "MS Office products, including Outlook, Excel, Word, and PowerPoint."
        ),
    ),
    Role(
        title="Scrum Master",
        qualifications=(
            "Education, Scrum Master (Cert)\n"
            "Jira, Handled Multiple Projects\n"
            "MS Office, Agile\n"
            "How you guided teams and the result\n"
            "Details of the projects\n"
            "MS Office suite: Outlook, Teams, Sharepoint, PowerPoint\n"
            "Industry"
        ),
    ),
    Role(
        title="Business Analyst",
        qualifications=(
            "SQL, Industry\n"
            "Microsoft 365, PowerPoint, Outlook, Excel (Advanced), Word, JIRA, SAP\n"
            "requirements gathering and documentation\n"
            "Influenced Cross-functional from IC to Stakeholders/managers and pro-actively solved business problems\n"
            "explain complex topics to non-technical\n"
            "Meet multiple deadlines concurrently\n"
            "Agile, Scrum, Waterfall\n"
            "Industry Tools: AI, Python, Tableau, Power BI, Cloud"
        ),
    ),
    Role(
        title="Business Analyst Intern",
        qualifications=(
            "Degree\n"
            "Basic knowledge of (SQL, Snowflake, Python, Tableau, Power BI, communicate and influence, Microsoft Windows and Office, including Word, PowerPoint, Advanced Excel, and Outlook), Deadlines, and organizational skills.\n"
            "Ability to work with others\n"
            "Takes direction and criticism"
        ),
    ),
    # ---- Design ----------------------------------------------------------
    Role(
        title="UI/UX Designer",
        qualifications=(
            "UX/UI design for X (Web, Mobile, etc)\n"
            "Figma, Sketch, Adobe XD, Illustrator, InVision, Adobe Creative Suite\n"
            "User Research, Usability Testing\n"
            "JavaScript, HTML, CSS\n"
            "manage multiple projects and meet deadlines\n"
            "Explain data to non-tech people (stakeholders) to improve user/customer experience\n"
            "Bonus: AI"
        ),
        aliases=("ux designer", "ui designer", "ux ui designer"),
    ),
    Role(
        title="Product Designer",
        qualifications=(
            "Degree/GED, Industry\n"
            "Start to finish, Research, UI/UX, product metrics, A/B testing, and user behavior analysis.\n"
            "Figma, Sketch, Illustrator, Photoshop, After effects\n"
            "Cross-functional, Stakeholders\n"
            "Web, Mobile, Desktop, B2B, Graphic Design, SAAS\n"
            "articulate product ideas and design choices clearly to both technical and non-technical audiences\n"
            "AI and/or a little bit of coding"
        ),
    ),
    Role(
        title="Product (UI/UX) Design Intern",
        qualifications=(
            "Degree, Portfolio\n"
            "Ability to work with others\n"
            "Takes direction and criticism\n"
            "Figma, Adobe Creative Suite, Google Workspace, A/B Testing, Wireframing (or Research), AI, UI/UX"
        ),
        aliases=("design intern", "ux design intern", "product design intern"),
    ),
    Role(
        title="Graphic Designer",
        qualifications=(
            "Degree, Portfolio\n"
            "Adobe InDesign, Illustrator, Photoshop, Acrobat, Figma\n"
            "Outlook, Microsoft Office, PowerPoint\n"
            "Industry (Sports, Entertainment, Lifestyle)\n"
            "Type of Design (Email, Print, etc)\n"
            "meet tight deadlines while managing multiple projects, brand consistency\n"
            "typography, layout, and visual hierarchy\n"
            "cross-functional, Bonus: JS, HTML, CSS, UI/UX, Animation, Multimedia Design, Fine Art, Film Studies, or CGI and 3D Modelling"
        ),
    ),
    Role(
        title="Technical Artist",
        qualifications=(
            "Shipped Product, VFX Pipelines, Unreal, Shader, Blueprint\n"
            "Spine, Adobe Suite (Photoshop, After Effects, Illustrator), 3D software (Maya, Blender, Cinema 4D)\n"
            "art asset optimization and how it affects gameplay performance\n"
            "Perforce, Jira, Confluence, MS Teams, and Excel.\n"
            "Python, C#, Java (Any Coding)\n"
            "Bonus: HLSL, PyMel"
        ),
    ),
    Role(
        title="Video Editor",
        qualifications=(
            "Premiere Pro, After Effects, and Media Encoder, Figma, DaVinci\n"
            "Mac/Windows Computer\n"
            "manage multiple projects of varying complexities, meet deadlines, and work well under pressure\n"
            "Type of Content (Sports, Politics, News)\n"
            "multiple video formats, resolutions and codecs\n"
            "Platform (YouTube, TikTok, Instagram, etc)"
        ),
    ),
    Role(
        title="Architectural Designer",
        qualifications=(
            "Degree in Architecture or related field\n"
            "Adobe Creative Suite (Photoshop, InDesign)\n"
            "working on or planned path to architectural licensure\n"
            "Microsoft Office Suite; experience with AutoCAD, Bluebeam, Revit\n"
            "Multitask, speak to different people and communicate\n"
            "BIM (Building Information Modeling) tools and processes, such as ACC and Procore.\n"
            "Drivers License\n"
            "Bonus: Rhino, Dynamo"
        ),
    ),
    # ---- Engineering (non-software) --------------------------------------
    Role(
        title="Mechanical Engineer",
        qualifications=(
            "Degree\n"
            "MS Office (Excel, Word, PowerPoint, Outlook)\n"
            "SolidWorks, CAD/AutoCAD\n"
            "Industry (Aerospace, BioMedical, etc)\n"
            "Type of Product (HVAC, Engines, Electrical Circuits)\n"
            "Basic Tools of the Industry/Product"
        ),
    ),
    Role(
        title="Mechanical Design Engineer",
        qualifications=(
            "Degree\n"
            "Type of Field (i.e. Aerospace) and Type of product (i.e. Engines, thermal science, etc)\n"
            "SolidWorks, AutoCAD, or Pro E; Finite Element Analysis (FEA), CFD\n"
            "Describe the products you worked on in a simple manner\n"
            "Common Tools for that section of the industry\n"
            "Drivers License"
        ),
    ),
    Role(
        title="Mechanical Engineering Intern",
        qualifications=(
            "Degree\n"
            "Basic knowledge of Industry (SolidWorks, CAD, documents, industry, what you work on, Microsoft Office, Revit 3D).\n"
            "Ability to work with others\n"
            "Takes direction and criticism"
        ),
    ),
    Role(
        title="Mechatronics Intern",
        qualifications=(
            "Degree, C++ and Python, ROS2\n"
            "3D printers, power tools, and hand tools\n"
            "mechanical design, drawings (SolidWorks), GD&T, Robotics, PLC, CAD\n"
            "mechanical, electrical, and software design\n"
            "Microsoft Office, specifically Microsoft Excel\n"
            "Work well with others, quick to change direction when you realize you've made a mistake"
        ),
    ),
    Role(
        title="Product Design Engineer",
        qualifications=(
            "Degree\n"
            "BOM, FEA, CFD, Geometric Dimensioning & Tolerancing (GD&T), ISO\n"
            "3D printing, CNC machining, injection molding, sheet metal\n"
            "CAD (3D, Solidworks)\n"
            "Microsoft Word, Excel, PowerPoint\n"
            "stress/strain, thermal, fatigue\n"
            "Cross-functional, Customers"
        ),
    ),
    Role(
        title="Manufacturing Engineer",
        qualifications=(
            "Degree, Industry\n"
            "CAD (NX, Solid Edge), CNC\n"
            "Manufacturing\n"
            "MS Office Suite, Project management (influence, multitasking, etc)\n"
            "continuous improvement environment (Lean, Six Sigma, process improvement, OPEX)\n"
            "Manufacturing specific regulations (cGMP and Medical Device, ISO, etc)"
        ),
    ),
    Role(
        title="Manufacturing Supervisor",
        qualifications=(
            "Degree/Highschool\n"
            "Manufacturing (type of product)\n"
            "Supervisory/leadership (#reports, how you supervised, how you solved issues with people, how you solved conflicts)\n"
            "Communicate with all levels in the organization (From Janitor to CEO)\n"
            "Microsoft Office (Word, Excel, Outlook, PowerPoint), basic math\n"
            "ISO 9001 or IATF 16949\n"
            "SAP, ERP\n"
            "Bonus: Nightshift or 24/7 coverage"
        ),
        aliases=("production supervisor",),
    ),
    Role(
        title="Electrical Engineer",
        qualifications=(
            "Degree\n"
            "AutoCAD, MATLAB\n"
            "SCADA, BMS, Product (Engines, Wheels)\n"
            "DFM/DFT Principles\n"
            "Microsoft Project, Excel, Word, Outlook\n"
            "Schematic and layout analog circuit design (amplifiers, filters, power supplies, noise issues)\n"
            "PLC (possibly)"
        ),
    ),
    Role(
        title="Electrical Design Engineer",
        qualifications=(
            "Degree\n"
            "Industry, Microsoft Office, AutoCAD/OrCAD\n"
            "Wiring/Harness, electromechanical (Assembly)\n"
            "Circuit, Schematic tools, FPGA, Microcontrollers\n"
            "PCB, SI/PI, MATLAB\n"
            "Siemens Xpedition, Cadence, KiCad\n"
            "Bonus: SPI, I2C, UART/serial, JTAG, and PCIe"
        ),
    ),
    Role(
        title="FPGA Engineer",
        qualifications=(
            "Degree\n"
            "FPGA (SystemVerilog or VHDL)\n"
            "DSP\n"
            "Agile/Iterative Development Life Cycle\n"
            "Cross Functional\n"
            "Explain complex technical issues to non-technical people\n"
            "Industry/Application"
        ),
    ),
    Role(
        title="Controls Engineer",
        qualifications=(
            "Degree\n"
            "PLC (Allen Bradley, Siemens), Robot (ABB)\n"
            "Coding knowledge (C#, Python, SQL, etc)\n"
            "assembling, operating, and troubleshooting robotics and electro-mechanical systems\n"
            "EPICS, I/O\n"
            "HMI/SCADA systems (FactoryTalk View, Ignition, Wonderware, etc)\n"
            "CAD software (e.g., Solidworks, OnShape)\n"
            "FAT/SAT\n"
            "Specific Certs (ISO, etc)"
        ),
        aliases=("plc engineer", "controls automation engineer"),
    ),
    Role(
        title="Automation Engineer",
        qualifications=(
            "Degree, PLC (Studio 5000, RSLogix, etc) Human Machine Interface (HMI, Studio 500, RSLogix)\n"
            "Automation-Allen Bradley & Siemens\n"
            "Multitask, servo-driven systems\n"
            "AutoCAD, Microsoft SQL\n"
            "Programming (C++, Visual Basic, Java, Python, etc.)"
        ),
    ),
    Role(
        title="Battery Engineer",
        qualifications=(
            "Masters/PhD\n"
            "Batteries, Type of Batteries\n"
            "CAD, SolidWorks, AutoCad, MATLAB\n"
            "Microsoft Office\n"
            "Industry of Batteries (Aerospace or EV)\n"
            "battery safety standards (e.g., UN 38.3, UL 1642/1973)\n"
            "Leadership\n"
            "Make it understandable to someone who did not graduate highschool"
        ),
    ),
    Role(
        title="Quality Engineer Intern",
        qualifications=(
            "Degree\n"
            "Basic knowledge of the Industry: SPC, FMEA, control charts, (Microsoft Office Excel, Word, PowerPoint), ISO, what you worked on and it's industry (i.e. Airplane Engineers), Manufacturing, ERP or SAP.\n"
            "Ability to work with others\n"
            "Takes direction and criticism"
        ),
    ),
    # ---- Science and research --------------------------------------------
    Role(
        title="Research Scientist",
        qualifications=(
            "Degree (Ph.D/Masters)\n"
            "Industry (BioMed, Aerospace, etc) and an understanding of Industry processes\n"
            "Knowledge of the topic (microbiology, immunology and biochemistry etc)\n"
            "Basic Industry Tools (Mass Spectrometry, assays, etc)\n"
            "Microsoft Office (Excel, Word, Outlook) and documentation skills\n"
            "Cross Functional, Lab experience, testing, troubleshooting\n"
            "Read documents, schedules, and manuals"
        ),
        # Not a bare "scientist". This row is a lab row — assays, mass spec,
        # bench work — and "Scientist" on its own covers data scientists,
        # materials scientists and research staff whose screens share almost
        # nothing with it. "Data Scientist" has its own row and matches exactly.
        aliases=("r&d scientist", "research and development scientist"),
    ),
    Role(
        title="Research Assistant",
        qualifications=(
            "Degree in Progress and/or HS\n"
            "Report Writing\n"
            "Industry\n"
            "Present Findings to non-technical people from lowest to highest\n"
            "Meet Deadlines and attention to detail\n"
            "Microsoft Office Tools (Outlook, Excel, Word, Powerpoint)"
        ),
    ),
    Role(
        title="Lab Manager",
        qualifications=(
            "Degree\n"
            "ISO, FDA, Industry\n"
            "Laboratory, Manufacturing, or technical facilities management role\n"
            "Common lab equipment (LC/MS, Centrifuges, Fume hoods, etc)\n"
            "Troubleshooting, maintenance\n"
            "Communicate tech to non-tech people, proactively solve problems\n"
            "Multi task and meet deadlines, MS Excel\n"
            "Managing vendors, service providers, operating budget"
        ),
    ),
    # ---- Finance and accounting ------------------------------------------
    Role(
        title="Financial Analyst",
        qualifications=(
            "Degree, Industry\n"
            "Excel, Office (Word, Outlook, PowerPoint) SQL, Python\n"
            "Financial Modeling, Statistical Analytics and Data Mining (with Excel if possible)\n"
            "Explain technical details to non-technical people\n"
            "Multitask and meet deadlines, Influence and/or manage stakeholders"
        ),
    ),
    Role(
        title="Staff Accountant",
        qualifications=(
            "Degree, CPA (Very nice to have)\n"
            "Microsoft Office (Excel, Outlook, etc.)\n"
            "Manage multiple active projects and deadlines\n"
            "GAAP\n"
            "Attention to detail\n"
            "Good communication (Verbal/Written)\n"
            "Nice to Have: General Ledger system such as Oracle Fusion"
        ),
        aliases=("accountant",),
    ),
    Role(
        title="Investment Banking Analyst",
        qualifications=(
            "Degree\n"
            "MS Office (Excel, PowerPoint, Word)\n"
            "Manage multiple workstreams and meet tight deadlines\n"
            "Banking OR Finance OR FP&A\n"
            "financial modeling, valuation, and accounting\n"
            "Communicate technical details to non-technical people (any communication)"
        ),
    ),
    Role(
        title="M&A Analyst",
        qualifications=(
            "Degree in Money\n"
            "Corporate Development or Financial Analysis\n"
            "Microsoft Office: Excel (Macros/Pivot tables) PowerPoint\n"
            "financial modeling\n"
            "multi-task, and produce quality work within tight deadlines\n"
            "Interact with stakeholders"
        ),
        aliases=("merger and acquisition analyst", "mergers and acquisitions analyst"),
    ),
    # ---- Sales, marketing, customer --------------------------------------
    Role(
        title="Sales Development Representative",
        qualifications=(
            "Salesforce, Outreach, ZoomInfo, HubSpot (CRM)\n"
            "Cold Calling, SDR, Customer\n"
            "Industry (SaaS, Healthcare, etc)\n"
            "Basic Computer Skills, B2B\n"
            "Talk to everyone from low to high\n"
            "Outreach through phone, email, text\n"
            "Teamwork, Hunger"
        ),
        aliases=("sdr", "business development representative", "bdr"),
    ),
    Role(
        title="Customer Success Manager",
        qualifications=(
            "Degree, Industry (Medical, Tech, etc)\n"
            "Proven success and meeting goals\n"
            "Retention, Customer engagement, and customer satisfaction, communicating to all, and explaining technical stuff to stakeholders, Negotiations\n"
            "Solved problems and multitasked\n"
            "CRM & CS tools (Hubspot), cross-sell and upsell, Salesforce\n"
            "SaaS or B2B, global Clients"
        ),
        aliases=("csm",),
    ),
    Role(
        title="Technical Account Manager",
        qualifications=(
            "Customer, Client, stakeholders (IC to VP)\n"
            "Travel, SDLC, Agile, SaaS, Cloud\n"
            "MSP, MSSP, IT, CRM\n"
            "Company/Tech Specific\n"
            "How you succeed"
        ),
        # Not a bare "account manager": that is a sales role, screened on quota,
        # pipeline and renewals, where this row is a post-sales technical one
        # screened on SDLC, SaaS and cloud. Neighbouring words, different jobs.
        aliases=("tam",),
    ),
    Role(
        title="Product Marketing Manager",
        qualifications=(
            "Degree\n"
            "B2B, SaaS/tech\n"
            "Meet deadlines and hold teams to deadlines\n"
            "Cross-functional/Matrixed, manage multiple projects\n"
            "Tools: Salesforce, Hubspot, CRM, AI\n"
            "How you succeeded and the impact of the success\n"
            "From beginning to end\n"
            "Used Data to succeed\n"
            "Tech to understandable content for both technical and non-technical audiences"
        ),
        aliases=("pmm",),
    ),
    Role(
        title="Content Marketing Manager",
        qualifications=(
            "Industry Specific, B2B, B2C, SEO\n"
            "content strategies across multiple formats (blogs, whitepapers, case studies, email campaigns, video scripts, landing pages)\n"
            "Cross Functional, WordPress\n"
            "How your marketing succeeded\n"
            "Brand Voice, Canva, Figma\n"
            "social media scheduling and analytics tools (e.g., Sprout Social, Hootsuite, HubSpot), Mailchimp, Marketo"
        ),
    ),
    Role(
        title="Growth Marketing Manager",
        qualifications=(
            "A/B testing, KPIs\n"
            "SEO, SQL, Anything with ADs\n"
            "Data Analytics Platforms (Tableau, Google Analytics, Power BI, Excel)\n"
            "Platforms (TikTok, YouTube, Print, Email)\n"
            "Industry, Salesforce, Hubspot\n"
            "B2B, B2C, SaaS, CAC, LTV\n"
            "Cross functional and influence stakeholders/teams"
        ),
    ),
    Role(
        title="Social Media Manager",
        qualifications=(
            "Types of Media (TikTok, LinkedIn, etc)\n"
            "Canva, Adobe Creative Suite, and PhotoShop, Asana and Sharepoint\n"
            "social media monitoring and analytics reporting\n"
            "Proven Success, content calendar\n"
            "MultiTask, Deadlines\n"
            "B2B, B2C, Analytics, writing and editing"
        ),
    ),
    Role(
        title="Communications Specialist",
        qualifications=(
            "Public Relations or Corporate Communications, Industry\n"
            "Explain complex topics to non-technical people, stakeholders, and customers\n"
            "Technical material into written narratives\n"
            "Meet deadlines while multitasking\n"
            "Microsoft Office 365 (Word, Excel, Outlook, SharePoint)\n"
            "Adobe, Photoshop, InDesign\n"
            "NO SPELLING OR GRAMMATICAL ERRORS"
        ),
    ),
    # ---- HR, operations, admin -------------------------------------------
    Role(
        title="Recruiter / Talent Acquisition Specialist",
        qualifications=(
            "Degree (sometimes)\n"
            "Industries (Tech vs Non-Tech), High Volume\n"
            "fill niche and complex openings\n"
            "ATS (Type), LinkedIn/Indeed, Boolean, Sourcing\n"
            "MS Office, negotiation, Compensation structures, full life cycle recruiting\n"
            "Customer Service with candidates, hiring managers, peers, and HR team\n"
            "influence stakeholders (HMs, HR, etc)\n"
            "Multitask"
        ),
        aliases=("recruiter", "talent acquisition specialist", "technical recruiter"),
    ),
    Role(
        title="HR Generalist",
        qualifications=(
            "HRIS platforms and Microsoft Office (MS Excel, Word and PowerPoint)\n"
            "Number of employees your past companies have had (ballpark)\n"
            "HR best practices and employment law\n"
            "employee relations, staffing and payroll\n"
            "Talent Acquisition, Industry, ATS\n"
            "Bonus: HR certification (SHRM-CP, PHR, etc.)"
        ),
    ),
    Role(
        title="HR Director",
        qualifications=(
            "Degree, Industry (Healthcare, Start Ups, etc)\n"
            "Talent Attraction (Recruitment, Scaling, Teams, Hiring)\n"
            "Retention and Systems (Equity compensation, Retention Strategies, X market knowledge)\n"
            "Influence Stakeholders, Numbers of employees and volume\n"
            "Multitask while meeting deadlines across cross-functional stakeholders. Speak to the lowest to the highest in the company\n"
            "HR laws, regulations, Policy\n"
            "Tech (HRIS, MS Office, etc)"
        ),
    ),
    Role(
        title="Operations Manager",
        qualifications=(
            "Industry, Warehouse, Degree\n"
            "Microsoft Office products. Examples include Word, Excel, Outlook, etc.\n"
            "staffing, selection, training, development, coaching, mentoring\n"
            "Leading non-stakeholders (conflict management, issues, etc) and stakeholder management/buy-in\n"
            "Meet Deadlines and be on schedule\n"
            "Nice to Have: KPI, SOP, cross-functional, Lean, Six Sigma"
        ),
    ),
    Role(
        title="Director of Customer Operations",
        qualifications=(
            "Degree\n"
            "Scaling/growing the company/processes\n"
            "Distill complex, cross-functional problems into clear, concise narratives and recommendations for stakeholders\n"
            "Size of company and budget\n"
            "Influence stakeholders and the company\n"
            "Leadership: Volume of people, budget, how you solved problems pro-actively with people\n"
            "Industry and tools (such as AI)"
        ),
    ),
    Role(
        title="Assistant General Manager",
        qualifications=(
            "Education\n"
            "Leadership experience, how you solved problems with people, coaching/training\n"
            "Industry\n"
            "Microsoft Office Word, Excel, PowerPoint, and Outlook\n"
            "scheduling, inventory management, and financial oversight, multitasking\n"
            "ability to influence people at all levels of the organization"
        ),
        aliases=("agm",),
    ),
    Role(
        title="Office Manager",
        qualifications=(
            "Degree, Microsoft Office (Excel, Word, PowerPoint)\n"
            "Multi Task, Customer Service (Clients, customers, internal stakeholders)\n"
            "Industry, how you documented and organized (Events, Schedules, normal day-to-day)"
        ),
    ),
    Role(
        title="Executive Assistant",
        qualifications=(
            "Education, Outlook, MS Office (Excel, Word, PDF, Powerpoint)\n"
            "Zoom, Microsoft Teams, etc\n"
            "Multitasking, Attention to Detail (no spelling errors)\n"
            "Setting up Meetings, Editing\n"
            "Calendar Management, Travel Arrangement (Executive)"
        ),
        aliases=("administrative assistant", "admin assistant", "executive administrative assistant"),
    ),
    Role(
        title="Data Entry",
        qualifications=(
            "Microsoft Office\n"
            "No Grammatical Errors\n"
            "scheduling and data organization\n"
            "Data Entry Experience\n"
            "Industry (Medical Software, CRM, etc)\n"
            "Multitask while meeting multiple deadlines"
        ),
        aliases=("data entry clerk", "data entry specialist"),
    ),
    Role(
        title="Director Level",
        qualifications=(
            "Education\n"
            "Influence at all levels (Stakeholders, Customers, clients)\n"
            "Industry Knowledge, Data Driven\n"
            "Changed the company\n"
            "How you solved problems and why you did that using other people\n"
            "Multi site or Global Teams or Matrixed, details of what you are in charge of\n"
            "Cross-functional\n"
            "Microsoft Office, including Excel, Word, and PowerPoint"
        ),
        aliases=("director",),
    ),
    # ---- Procurement and vendor ------------------------------------------
    Role(
        title="Buyer / Procurement",
        qualifications=(
            "Industry, Supply chain\n"
            "Supplier relationship, Organizing\n"
            "Microsoft Office: Excel, Word, Outlook, Gmail\n"
            "Timeline development, Meets deadlines."
        ),
        aliases=("buyer", "procurement specialist"),
    ),
    Role(
        title="Procurement Manager",
        qualifications=(
            "Degree/HS Diploma, Certs\n"
            "Sourcing, Procurement, Supply chain, or Category Management\n"
            "Vendor, Supplier, Contract Management\n"
            "Influence Stakeholders and stakeholder management\n"
            "MS Office, Excel\n"
            "Power BI, Tableau\n"
            "negotiate effectively and manage supplier relationships\n"
            "Cross Functional, Supply Chain\n"
            "Industry (Categories)"
        ),
    ),
    Role(
        title="Vendor Manager",
        qualifications=(
            "Vendor Managment, Contracts, Due Diligence\n"
            "Stakeholder Management, Influence Stakeholder\n"
            "Industry\n"
            "Microsoft Office (Excel, Pivot Tables, Complex Formula)"
        ),
    ),
    Role(
        title="Technical Partner Manager",
        qualifications=(
            "Industry (SaaS, IT, Healthcare, APIs, etc)\n"
            "managing complex partner or vendor relationships, Contracts\n"
            "ability to partner with, influence and drive collaboration amongst cross-function and cross-regional teams\n"
            "SLAs, and negotiation processes with vendors\n"
            "Salesforce, Jira, GSuite/Excel/Office, Slack, GitHub\n"
            "Agile, Scrum\n"
            "Multitask"
        ),
        aliases=("partner manager", "partnerships manager"),
    ),
    # ---- Healthcare and retail -------------------------------------------
    Role(
        title="Health Information Specialist",
        qualifications=(
            "High school plus a little college\n"
            "Health experience, Medical Record\n"
            "MS Outlook, MS Excel, MS Word\n"
            "Customer Service\n"
            "Healthcare Knowledge (HIPPA, etc)"
        ),
    ),
    Role(
        title="Patient Access Coordinator",
        qualifications=(
            "High school or Prior Experience\n"
            "Medical billing, scheduling\n"
            "Medical office, Computer Skills (Office)\n"
            "One of: Admin, Receptionist, Front Office\n"
            "Customer Service\n"
            "Organizational detail, ability to meet deadlines, Multitask\n"
            "Drivers License"
        ),
    ),
    Role(
        title="Retail Manager",
        qualifications=(
            "GED/DEGREE Customer Service, Sales\n"
            "Multitask under deadlines/pressure, how you led others to success/solving disputes\n"
            "POS systems and retail management software\n"
            "MS Office, Teams, Skype, Zoom Shopify"
        ),
        aliases=("store manager",),
    ),
    Role(
        title="Cashier",
        qualifications=(
            "Basic Computing Skills (MS Office)\n"
            "Retail Experience, customer service (phone/in-person)\n"
            "Flexible Schedule\n"
            "POS (if you have it)\n"
            "Cash-handling, Basic Math\n"
            "Multitask"
        ),
    ),
)


# --------------------------------------------------------------------------
# Matching
# --------------------------------------------------------------------------

#: Words that describe *how senior* someone is, not *what they do*. A staff
#: engineer and a junior engineer are screened against the same qualification
#: list; the difference is how much of it they have to evidence.
_SENIORITY = frozenset(
    {
        "senior", "sr", "junior", "jr", "staff", "principal", "lead", "head",
        "chief", "entry", "mid", "level", "associate", "assistant", "i", "ii",
        "iii", "iv", "1", "2", "3", "4",
    }
)

#: Words that carry no screening information wherever they appear.
_FILLER = frozenset({"the", "a", "an", "of", "and", "for", "role", "position", "job"})

#: Market hints, so an EU or Canadian query can reach its own row and a plain
#: query never accidentally does.
_REGION_WORDS = {
    "eu": "EU",
    "europe": "EU",
    "european": "EU",
    "uk": "UK",
    "britain": "UK",
    "canada": "CA",
    "canadian": "CA",
    "india": "IN",
    "indian": "IN",
    "us": "US",
    "usa": "US",
    "america": "US",
    "american": "US",
}

#: Spellings that mean the same thing. Applied to the raw string before it is
#: split, so multi-word expansions work.
_REWRITES = (
    (r"\bfront[\s-]?end\b", "front end"),
    (r"\bback[\s-]?end\b", "back end"),
    (r"\bfull[\s-]?stack\b", "full stack"),
    (r"\bswe\b", "software engineer"),
    (r"\bdev\b", "developer"),
    (r"\bml\b", "machine learning"),
    (r"\bqa\b", "quality assurance"),
    (r"\bsec\b", "security"),
    (r"\binfosec\b", "information security"),
    (r"\bui\s*/?\s*ux\b", "ui ux"),
    (r"\bux\s*/?\s*ui\b", "ui ux"),
)

#: How much of a candidate title a query has to look like before the match is
#: trusted. Jaccard overlap of the two token sets, so 0.6 means "most of both
#: titles is the same words" — "software engineer" against "software engineer
#: intern" scores 0.67 and matches, "backend engineer" against "backend java
#: developer" scores 0.25 and does not. Wrong qualifications are worse than
#: none, so this errs toward none.
_MATCH_THRESHOLD = 0.6


def _normalise(text: str) -> str:
    """Lowercase, expand the common spellings, and reduce to words and spaces."""
    lowered = text.lower()
    for pattern, replacement in _REWRITES:
        lowered = re.sub(pattern, replacement, lowered)
    # `#` and `.` survive as themselves nowhere useful — "C#/.NET" and "C# .NET"
    # must reach the same tokens — so everything that isn't a letter or digit
    # becomes a space.
    return re.sub(r"[^a-z0-9]+", " ", lowered).strip()


#: Words that make a title a different screen rather than a nearby one, so a
#: title carrying one only matches a title carrying it too.
#:
#: Without this gate "Software Engineer" matches "Software Engineer Intern" — two
#: of three words shared, comfortably over the threshold — and a mid-career
#: engineer gets handed "takes direction and criticism" as their requirement
#: list. An internship is screened for entirely different things, which is why
#: the table has separate rows for them at all.
_GATES = frozenset({"intern", "internship"})

#: Words that say what *kind* of job it is rather than which one. They appear in
#: dozens of titles here, so an overlap made only of these is not a match.
#:
#: Without this, "Software Engineer" scores 0.67 against "Embedded Software
#: Engineer" — two words out of three — and a generic query silently acquires
#: RTOS and I2C. The table deliberately has no generic software-engineer row, and
#: the honest answer to a generic query is that there isn't one.
_GENERIC = frozenset(
    {
        "software", "engineer", "engineering", "developer", "development",
        "manager", "analyst", "specialist", "coordinator", "tech",
        "consultant", "administrator", "architect", "designer", "scientist",
        "representative", "support", "operations",
    }
)
# Deliberately *not* generic: "technical". It reads like a filler adjective and
# is not one — "Technical Account Manager" and "Account Manager" are a post-sales
# engineering role and a sales role, and "technical" is the entire difference
# between them. Listing it here would let the broad title collect the narrow
# row's requirements.


def _tokens(text: str) -> frozenset[str]:
    """The words that actually carry screening information."""
    words = _normalise(text).split()
    return frozenset(
        word for word in words if word not in _SENIORITY and word not in _FILLER
    )


def _region_of(query: str) -> str | None:
    """The market a query names, if it names one."""
    for word in _normalise(query).split():
        if word in _REGION_WORDS:
            return _REGION_WORDS[word]
    return None


def is_lead(role_title: str) -> bool:
    """Whether the title is a lead one, so `LEAD_MODIFIER` applies on top."""
    return "lead" in _normalise(role_title).split()


def _score(query_tokens: frozenset[str], candidate_tokens: frozenset[str]) -> float:
    """Jaccard overlap: shared words over all words either title used.

    Zero when the two disagree about a gate word, and zero when everything they
    share is generic — in both cases however much else they have in common.
    """
    if not query_tokens or not candidate_tokens:
        return 0.0
    if (query_tokens & _GATES) != (candidate_tokens & _GATES):
        return 0.0
    shared = query_tokens & candidate_tokens
    if not shared - _GENERIC:
        return 0.0

    # The candidate names something the query didn't. Where that something is a
    # real qualifier rather than a filler noun, the candidate is a *narrower*
    # role than the one asked for, and answering the broad question with the
    # narrow row's list is the mistake this whole function is shaped around:
    # "Systems Engineer" is not an embedded engineer, and "Account Manager" is
    # not a technical account manager. Both score 0.67 on words alone.
    #
    # Generic extras don't count, so "front end engineer" still reaches "Front
    # End Software Engineer" — "software" adds no requirement, where "embedded"
    # adds every requirement.
    if (candidate_tokens - query_tokens) - _GENERIC:
        return 0.0

    union = query_tokens | candidate_tokens
    return len(shared) / len(union)


def find_role(query: str) -> Role | None:
    """The reference row for a job title, or None when nothing is close enough.

    None is a normal answer, not a failure. The table covers a hundred-odd
    titles out of the thousands people apply to, and the caller's fallback — the
    model's own knowledge of the role — is far better than a confidently wrong
    list of qualifications from a neighbouring job.
    """
    asked = _normalise(query)
    if not asked:
        return None

    # The market asked for wins, and US is the default — otherwise "full stack
    # engineer" is a three-way tie between the US, Canadian and EU rows, decided
    # by declaration order. But it is only a *preference*: the non-US rows are a
    # handful, so searching them alone would mean naming a market made most
    # titles harder to find, and someone in Canada applying for a Data Engineer
    # job wants the Data Engineer list. So the preferred market is searched
    # first, and everything else only if it turned up nothing.
    preferred = _region_of(query) or "US"
    groups = (
        [role for role in ROLES if role.region == preferred],
        [role for role in ROLES if role.region != preferred],
    )

    query_tokens = _tokens(query)
    for candidates in groups:
        # Exact, on the title or any alias, normalised the same way. Beats fuzzy
        # matching outright — "AI Developer" and "AI Engineer" are both real rows
        # and both score well against each other.
        for role in candidates:
            if asked == _normalise(role.title):
                return role
            if any(asked == _normalise(alias) for alias in role.aliases):
                return role

        # Then the closest in this group, if anything is close enough.
        best: Role | None = None
        best_score = 0.0
        for role in candidates:
            for name in (role.title, *role.aliases):
                score = _score(query_tokens, _tokens(name))
                if score > best_score:
                    best_score, best = score, role
        if best_score >= _MATCH_THRESHOLD:
            return best
    return None


def qualifications_for(query: str) -> tuple[str, str] | None:
    """``(matched title, qualifications)`` for a job title, or None.

    The lead modifier is appended when the title asked for is a lead one, since
    a lead position is screened for everything the role is *plus* the leading.
    """
    role = find_role(query)
    if role is None:
        return None
    qualifications = role.qualifications
    if is_lead(query) and not is_lead(role.title):
        qualifications = f"{qualifications}\nAs a lead: {LEAD_MODIFIER}"
    return role.title, qualifications


__all__ = [
    "LEAD_MODIFIER",
    "ROLES",
    "Role",
    "find_role",
    "is_lead",
    "qualifications_for",
]
