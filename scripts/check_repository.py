#!/usr/bin/env python3
"""Validate repository policies and foundational files."""

from __future__ import annotations

import re
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote

try:
    import yaml
except ImportError:  # Reported as a repository-check failure in check_yaml_syntax.
    yaml = None


if yaml is not None:

    class RepositoryYamlLoader(yaml.SafeLoader):
        """Load repository YAML with YAML 1.2 boolean spelling."""

    RepositoryYamlLoader.yaml_implicit_resolvers = {
        key: list(resolvers)
        for key, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
    }
    for (
        first_character,
        resolvers,
    ) in RepositoryYamlLoader.yaml_implicit_resolvers.items():
        RepositoryYamlLoader.yaml_implicit_resolvers[first_character] = [
            (tag, pattern)
            for tag, pattern in resolvers
            if tag != "tag:yaml.org,2002:bool"
        ]
    RepositoryYamlLoader.add_implicit_resolver(
        "tag:yaml.org,2002:bool",
        re.compile(r"^(?:true|false)$", re.IGNORECASE),
        list("tTfF"),
    )
else:
    RepositoryYamlLoader = None


EXCLUDED_DIRECTORIES = {
    ".git",
    ".venv",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "playwright-report",
    "test-results",
}
TEXT_SUFFIXES = {
    ".css",
    ".html",
    ".js",
    ".json",
    ".lock",
    ".md",
    ".mjs",
    ".py",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".wgsl",
    ".yaml",
    ".yml",
}
TEXT_NAMES = {
    ".editorconfig",
    ".gitattributes",
    ".gitignore",
    "LICENSE",
}
TIMELESS_DOCUMENTS = {
    "AGENTS.md",
    "CONTRIBUTING.md",
    "README.md",
    "SECURITY.md",
    "docs/README.md",
    "docs/agent-workflow.md",
    "docs/compatibility.md",
    "docs/continuous-integration.md",
    "docs/dependencies.md",
    "docs/development.md",
    "docs/documentation.md",
    "docs/generated-files.md",
    "docs/performance.md",
    "docs/project-management.md",
    "docs/quality.md",
    "docs/releases.md",
    "docs/agent-instruction-review.md",
    "docs/version-control.md",
}
REQUIRED_FILES = TIMELESS_DOCUMENTS | {
    ".editorconfig",
    ".gitattributes",
    ".github/pull_request_template.md",
    ".github/workflows/repository-checks.yml",
    ".gitignore",
    "CHANGELOG.md",
    "requirements-dev.lock",
    "ruff.toml",
    "scripts/check_repository.py",
    "scripts/run_tests.py",
    "tests/test_repository_checks.py",
}
REQUIRED_EDITORCONFIG_SETTINGS = {
    "": {
        "root": "true",
    },
    "*": {
        "charset": "utf-8",
        "end_of_line": "lf",
        "insert_final_newline": "true",
        "trim_trailing_whitespace": "true",
    },
    "*.py": {
        "indent_size": "4",
    },
}
REQUIRED_GITATTRIBUTE_RULES = {
    "* text=auto eol=lf",
    "*.gif binary",
    "*.ico binary",
    "*.jpeg binary",
    "*.jpg binary",
    "*.png binary",
    "*.wasm binary",
    "*.woff binary",
    "*.woff2 binary",
}
REQUIRED_GITIGNORE_RULES = {
    ".env",
    ".env.*",
    "!.env.example",
    ".ruff_cache/",
    ".venv/",
    "__pycache__/",
    "build/",
    "dist/",
    "node_modules/",
    "test-results/",
}
REQUIRED_PULL_REQUEST_HEADINGS = {
    "Linked issue",
    "Verification",
    "Required evidence",
    "Ready for review",
    "Ready to merge",
}
REQUIRED_PULL_REQUEST_TEXT = {
    "docs/quality.md",
    "explicit authorization",
}
EXPECTED_RUFF_CONFIGURATION = {
    "target-version": "py311",
    "line-length": 88,
    "lint": {"select": ["B", "E4", "E7", "E9", "F", "I", "RUF", "UP"]},
    "format": {"line-ending": "lf"},
}
REQUIRED_ISSUE_FIELDS = {
    "problem",
    "why-it-matters",
    "expected-result",
    "scope",
    "completion-conditions",
    "dependencies-related-work",
    "effects-risks",
}
ISSUE_FORM_REQUIREMENTS = {
    "bug.yml": {
        "label": "type: bug",
        "fields": {
            "actual-behavior",
            "environment",
            "evidence",
            "expected-behavior",
            "reproduction",
            "version-commit",
            "worked-before",
        },
    },
    "documentation.yml": {
        "label": "type: documentation",
        "fields": {
            "affected-documentation",
            "authoritative-sources",
            "intended-reader",
            "unanswered-question",
        },
    },
    "feature.yml": {
        "label": "type: feature",
        "fields": {
            "behavior-example",
            "deferred-behavior",
            "public-interface",
            "pytorch-reference",
            "user-need",
        },
    },
    "maintenance.yml": {
        "label": "type: maintenance",
        "fields": {
            "affected-parts",
            "concrete-improvement",
            "maintenance-evidence",
            "preserved-behavior",
        },
    },
    "research.yml": {
        "label": "type: research",
        "fields": {
            "alternatives",
            "available-evidence",
            "comparison-conditions",
            "informed-decision",
            "investigation",
            "research-completeness",
            "research-question",
        },
    },
}
REQUIRED_ISSUE_FORMS = set(ISSUE_FORM_REQUIREMENTS)
REQUIRED_SKILLS = {
    "tabgrad-architecture",
    "tabgrad-implement",
    "tabgrad-issue",
    "tabgrad-maintenance",
    "tabgrad-merge",
    "tabgrad-pull-request",
    "tabgrad-research",
    "tabgrad-review",
    "tabgrad-start",
    "tabgrad-verify",
}
QUALITY_POLICY_CONSUMERS = {
    ".agents/skills/tabgrad-implement/SKILL.md",
    ".agents/skills/tabgrad-maintenance/SKILL.md",
    ".agents/skills/tabgrad-review/SKILL.md",
    ".agents/skills/tabgrad-verify/SKILL.md",
    ".github/pull_request_template.md",
    "CONTRIBUTING.md",
}
INSTRUCTION_REVIEW_ROUTES = {
    "AGENTS.md": "docs/agent-instruction-review.md",
    "docs/README.md": "agent-instruction-review.md",
}
PROJECT_PROGRESS_PATTERNS = (
    re.compile(
        r"(?:^|\s)## current (?:support|workflow|register|implementation|project)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:runtime|backend|component|feature|capability|compatibility layer|integration)\b"
        r"[^.]{0,80}\bcurrently\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bcurrently\b[^.]{0,80}"
        r"\b(?:runtime|backend|component|feature|capability|compatibility layer|integration)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:runtime|backend|component|feature|capability|compatibility layer|integration)\b"
        r"[^.]{0,80}\bnot yet\b[^.]{0,30}"
        r"\b(?:implemented|available|configured|built|supported|provided|present)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:runtime|backend|component|feature|capability|compatibility layer|integration)\b"
        r"[^.]{0,80}\b(?:has not been implemented|does not yet exist)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bno (?:runtime|backend|component|feature|capability|compatibility layer|integration)\b"
        r"[^.]{0,80}\bexists?\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bonce (?:the )?(?:runtime|backends?|compatibility layer)\b[^.]{0,30}\bexist(?:s)?\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:runtime|backend|component|feature|capability|compatibility layer|integration)\b"
        r"[^.]{0,80}\b(?:will be (?:added|implemented|created|configured|introduced)|is planned)\b"
        r"[^.]{0,80}\b(?:(?:in|for) (?:a )?(?:later|future|subsequent) (?:phase|stage)|later|eventually)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\bstrongest current hypothesis\b", re.IGNORECASE),
)
MARKDOWN_LINK = re.compile(r"\[[^\]]+\]\((<[^>]+>|[^)\s]+)")
FULL_COMMIT_ACTION = re.compile(r"^[^@\s]+@[0-9a-f]{40}$")
APPROVED_WORKFLOW_PATHS = {
    Path(".github/workflows/repository-checks.yml"),
}
CI_INSTALL_COMMAND = (
    "python -m pip install --only-binary=:all: --require-hashes "
    "-r requirements-dev.lock"
)
CI_FORMAT_COMMAND = "python3 -m ruff format --check scripts tests"
CI_LINT_COMMAND = "python3 -m ruff check scripts tests"
CI_VALIDATE_COMMAND = "python3 scripts/check_repository.py"
CI_TEST_COMMAND = "python3 scripts/run_tests.py"
REQUIRED_CI_COMMANDS = {
    CI_INSTALL_COMMAND,
    CI_FORMAT_COMMAND,
    CI_LINT_COMMAND,
    CI_VALIDATE_COMMAND,
    CI_TEST_COMMAND,
}
CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
SETUP_PYTHON_ACTION = "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97"
APPROVED_ACTIONS = {
    CHECKOUT_ACTION: "v7.0.1",
    SETUP_PYTHON_ACTION: "v7.0.0",
}
EXPECTED_REPOSITORY_CHECKS_WORKFLOW = {
    "name": "Repository checks",
    "on": {
        "pull_request": None,
        "push": {"branches": ["main"]},
        "workflow_dispatch": None,
    },
    "permissions": {"contents": "read"},
    "concurrency": {
        "group": "repository-checks-${{ github.workflow }}-${{ github.ref }}",
        "cancel-in-progress": True,
    },
    "jobs": {
        "repository-consistency": {
            "name": "repository-consistency",
            "runs-on": "ubuntu-24.04",
            "timeout-minutes": 5,
            "steps": [
                {
                    "name": "Check out the repository",
                    "uses": CHECKOUT_ACTION,
                    "with": {"persist-credentials": False},
                },
                {
                    "name": "Set up Python",
                    "uses": SETUP_PYTHON_ACTION,
                    "with": {
                        "python-version": "3.11.9",
                        "check-latest": False,
                    },
                },
                {
                    "name": "Install locked development dependencies",
                    "run": CI_INSTALL_COMMAND,
                },
                {"name": "Check Python formatting", "run": CI_FORMAT_COMMAND},
                {"name": "Lint Python", "run": CI_LINT_COMMAND},
                {
                    "name": "Validate repository policies and structure",
                    "run": CI_VALIDATE_COMMAND,
                },
                {"name": "Test the repository validator", "run": CI_TEST_COMMAND},
            ],
        }
    },
}


@dataclass(frozen=True)
class Failure:
    path: Path
    message: str


@dataclass(frozen=True)
class YamlRepositoryState:
    available: bool
    documents: dict[Path, object]
    invalid_paths: frozenset[Path]
    failures: tuple[Failure, ...]


def repository_files(root: Path) -> list[Path]:
    files = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in EXCLUDED_DIRECTORIES for part in path.relative_to(root).parts):
            continue
        files.append(path)
    return sorted(files)


def text_files(root: Path) -> list[Path]:
    return [
        path
        for path in repository_files(root)
        if path.suffix.lower() in TEXT_SUFFIXES or path.name in TEXT_NAMES
    ]


def check_text_format(root: Path) -> list[Failure]:
    failures = []
    for path in text_files(root):
        relative = path.relative_to(root)
        raw = path.read_bytes()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            failures.append(Failure(relative, "is not valid UTF-8"))
            continue
        if "\r" in text:
            failures.append(
                Failure(relative, "contains a carriage return; use LF line endings")
            )
        if text and not text.endswith("\n"):
            failures.append(Failure(relative, "does not end with a newline"))
        for number, line in enumerate(text.splitlines(), start=1):
            if line.rstrip(" \t") != line:
                failures.append(
                    Failure(relative, f"line {number} has trailing whitespace")
                )
    return failures


def check_markdown_links(root: Path) -> list[Failure]:
    failures = []
    for path in text_files(root):
        if path.suffix.lower() != ".md":
            continue
        text = path.read_text(encoding="utf-8")
        for match in MARKDOWN_LINK.finditer(text):
            destination = match.group(1).strip("<>")
            if destination.startswith(("#", "http://", "https://", "mailto:")):
                continue
            destination = unquote(destination.split("#", 1)[0].split("?", 1)[0])
            if not destination:
                continue
            target = (
                root / destination.lstrip("/")
                if destination.startswith("/")
                else path.parent / destination
            )
            resolved_target = target.resolve()
            try:
                resolved_target.relative_to(root.resolve())
            except ValueError:
                line = text.count("\n", 0, match.start()) + 1
                failures.append(
                    Failure(
                        path.relative_to(root),
                        f"line {line} links outside the repository",
                    )
                )
                continue
            if not resolved_target.exists():
                line = text.count("\n", 0, match.start()) + 1
                failures.append(
                    Failure(
                        path.relative_to(root),
                        f"line {line} links to missing {destination}",
                    )
                )
    return failures


def contains_recursive_yaml_alias(
    value: object, ancestors: frozenset[int] = frozenset()
) -> bool:
    if not isinstance(value, (dict, list)):
        return False
    identity = id(value)
    if identity in ancestors:
        return True
    child_ancestors = ancestors | {identity}
    children = value.values() if isinstance(value, dict) else value
    return any(
        contains_recursive_yaml_alias(child, child_ancestors) for child in children
    )


def load_yaml_repository(root: Path) -> YamlRepositoryState:
    yaml_paths = [
        path
        for path in repository_files(root)
        if path.suffix.lower() in {".yaml", ".yml"}
    ]
    if yaml is None:
        failure = Failure(
            Path("requirements-dev.lock"),
            "development dependencies are not installed; follow docs/development.md",
        )
        return YamlRepositoryState(False, {}, frozenset(), (failure,))

    documents = {}
    invalid_paths = set()
    failures = []
    for path in yaml_paths:
        relative = path.relative_to(root)
        text = path.read_text(encoding="utf-8")
        try:
            document = yaml.load(text, Loader=RepositoryYamlLoader)
        except yaml.YAMLError as error:
            failures.append(Failure(relative, f"contains invalid YAML: {error}"))
            invalid_paths.add(relative)
            continue
        documents[relative] = document
        if document is not None and not isinstance(document, (dict, list)):
            failures.append(
                Failure(
                    relative,
                    "must contain a YAML mapping or list at its root",
                )
            )
            invalid_paths.add(relative)
        elif contains_recursive_yaml_alias(document):
            failures.append(Failure(relative, "contains a recursive YAML alias"))
            invalid_paths.add(relative)
    return YamlRepositoryState(
        True,
        documents,
        frozenset(invalid_paths),
        tuple(failures),
    )


def acquire_yaml_state(
    root: Path, yaml_state: YamlRepositoryState | None
) -> tuple[YamlRepositoryState, list[Failure]]:
    owns_yaml_state = yaml_state is None
    state = yaml_state or load_yaml_repository(root)
    failures = list(state.failures) if owns_yaml_state else []
    return state, failures


def check_yaml_syntax(
    root: Path, yaml_state: YamlRepositoryState | None = None
) -> list[Failure]:
    state = yaml_state or load_yaml_repository(root)
    return list(state.failures)


def parse_frontmatter(
    path: Path,
) -> tuple[dict[str, object] | None, str, str | None]:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        return None, text, "is missing YAML frontmatter"
    end = text.find("\n---\n", 4)
    if end < 0:
        return None, text, "has unterminated YAML frontmatter"
    body = text[end + 5 :]
    if yaml is None:
        return None, body, None
    try:
        fields = yaml.load(text[4:end], Loader=RepositoryYamlLoader)
    except yaml.YAMLError as error:
        return None, body, f"contains invalid frontmatter YAML: {error}"
    if not isinstance(fields, dict):
        return None, body, "frontmatter must contain a YAML mapping"
    return fields, body, None


def installed_skill_names(root: Path) -> set[str]:
    skills_root = root / ".agents" / "skills"
    if not skills_root.is_dir():
        return set()
    return {path.name for path in skills_root.iterdir() if path.is_dir()}


def check_skills(root: Path) -> list[Failure]:
    failures = []
    skills_root = root / ".agents" / "skills"
    if not skills_root.is_dir():
        return [Failure(Path(".agents/skills"), "skill directory is missing")]
    present_skills = installed_skill_names(root)
    missing_skills = sorted(REQUIRED_SKILLS.difference(present_skills))
    if missing_skills:
        failures.append(
            Failure(
                Path(".agents/skills"),
                f"is missing required skills: {', '.join(missing_skills)}",
            )
        )

    agents_path = root / "AGENTS.md"
    if not agents_path.is_file():
        failures.append(
            Failure(
                Path("AGENTS.md"),
                "is missing, so required skill routing cannot be checked",
            )
        )
    else:
        visible_agents_text = visible_markdown_text(
            agents_path.read_text(encoding="utf-8")
        )
        declared_skills = set(re.findall(r"\$([a-z][a-z0-9-]+)", visible_agents_text))
        missing_declarations = sorted(present_skills.difference(declared_skills))
        missing_directories = sorted(declared_skills.difference(present_skills))
        if missing_declarations:
            failures.append(
                Failure(
                    Path("AGENTS.md"),
                    f"does not declare installed skills: {', '.join(missing_declarations)}",
                )
            )
        if missing_directories:
            failures.append(
                Failure(
                    Path("AGENTS.md"),
                    f"declares skills without directories: {', '.join(missing_directories)}",
                )
            )
        if declared_skills != REQUIRED_SKILLS:
            failures.append(
                Failure(
                    Path("AGENTS.md"),
                    "required skill routing does not match the validator registry",
                )
            )
    for directory in sorted(path for path in skills_root.iterdir() if path.is_dir()):
        skill_file = directory / "SKILL.md"
        relative = skill_file.relative_to(root)
        if not skill_file.is_file():
            failures.append(Failure(relative, "is missing"))
            continue
        frontmatter, body, frontmatter_error = parse_frontmatter(skill_file)
        if frontmatter_error:
            failures.append(Failure(relative, frontmatter_error))
        elif frontmatter is not None:
            name = frontmatter.get("name")
            description = frontmatter.get("description")
            if not isinstance(name, str) or name != directory.name:
                failures.append(
                    Failure(relative, "frontmatter name does not match its directory")
                )
            if not isinstance(description, str) or not description.strip():
                failures.append(
                    Failure(relative, "frontmatter description is missing or invalid")
                )
        if "docs/agent-workflow.md" not in visible_markdown_text(body):
            failures.append(
                Failure(relative, "does not reference the common agent workflow")
            )
        if re.search(r"\b(TODO|TBD|PLACEHOLDER)\b", body, re.IGNORECASE):
            failures.append(Failure(relative, "contains an unfinished placeholder"))
    return failures


def check_issue_forms(
    root: Path, yaml_state: YamlRepositoryState | None = None
) -> list[Failure]:
    state, failures = acquire_yaml_state(root, yaml_state)
    if not state.available:
        return failures
    forms = root / ".github" / "ISSUE_TEMPLATE"
    present_forms = {
        path.name for path in forms.glob("*.yml") if path.name != "config.yml"
    }
    missing_forms = sorted(REQUIRED_ISSUE_FORMS.difference(present_forms))
    unexpected_forms = sorted(present_forms.difference(REQUIRED_ISSUE_FORMS))
    if missing_forms:
        failures.append(
            Failure(
                forms.relative_to(root),
                f"is missing required issue forms: {', '.join(missing_forms)}",
            )
        )
    if unexpected_forms:
        failures.append(
            Failure(
                forms.relative_to(root),
                f"contains unregistered issue forms: {', '.join(unexpected_forms)}",
            )
        )
    config = forms / "config.yml"
    if not config.is_file():
        failures.append(Failure(config.relative_to(root), "is missing"))
    elif config.relative_to(root) not in state.invalid_paths:
        config_document = state.documents.get(config.relative_to(root))
        if (
            not isinstance(config_document, dict)
            or config_document.get("blank_issues_enabled") is not False
        ):
            failures.append(
                Failure(config.relative_to(root), "must disable blank issues")
            )
        contact_links = (
            config_document.get("contact_links", [])
            if isinstance(config_document, dict)
            else []
        )
        if not any(
            isinstance(link, dict)
            and "security/advisories/new" in str(link.get("url", ""))
            for link in contact_links
        ):
            failures.append(
                Failure(
                    config.relative_to(root),
                    "does not link private vulnerability reporting",
                )
            )

    for path in sorted(forms.glob("*.yml")):
        if path.name == "config.yml":
            continue
        relative = path.relative_to(root)
        if relative in state.invalid_paths:
            continue
        document = state.documents.get(relative)
        if not isinstance(document, dict):
            failures.append(Failure(relative, "must contain a YAML mapping"))
            continue
        if not isinstance(document.get("name"), str) or not isinstance(
            document.get("description"), str
        ):
            failures.append(
                Failure(path.relative_to(root), "must declare a name and description")
            )
        body = document.get("body")
        if not isinstance(body, list):
            failures.append(Failure(path.relative_to(root), "must contain a body list"))
            continue
        fields = [item for item in body if isinstance(item, dict) and "id" in item]
        ids = [str(item["id"]) for item in fields]
        if len(ids) != len(set(ids)):
            failures.append(
                Failure(path.relative_to(root), "contains duplicate field ids")
            )
        requirements = ISSUE_FORM_REQUIREMENTS.get(path.name)
        required_ids = REQUIRED_ISSUE_FIELDS | (
            requirements["fields"] if requirements else set()
        )
        missing = sorted(required_ids.difference(ids))
        if missing:
            failures.append(
                Failure(
                    path.relative_to(root),
                    f"is missing required fields: {', '.join(missing)}",
                )
            )
        field_by_id = {str(item["id"]): item for item in fields}
        nonrequired = sorted(
            identifier
            for identifier in required_ids.intersection(field_by_id)
            if not isinstance(field_by_id[identifier].get("validations"), dict)
            or field_by_id[identifier]["validations"].get("required") is not True
        )
        if nonrequired:
            failures.append(
                Failure(
                    path.relative_to(root),
                    f"has fields that are not required: {', '.join(nonrequired)}",
                )
            )
        labels = document.get("labels")
        expected_label = requirements["label"] if requirements else None
        if expected_label and (
            not isinstance(labels, list) or labels != [expected_label]
        ):
            failures.append(
                Failure(
                    path.relative_to(root),
                    f"must declare only the {expected_label!r} label",
                )
            )
    return failures


def find_workflow_string_values(
    value: object, path: Path, field: str
) -> tuple[list[tuple[Path, str]], list[Failure]]:
    values = []
    failures = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key == field:
                if isinstance(child, str):
                    values.append((path, child))
                else:
                    failures.append(
                        Failure(
                            path,
                            f"contains a {field} value that is not text",
                        )
                    )
            child_values, child_failures = find_workflow_string_values(
                child, path, field
            )
            values.extend(child_values)
            failures.extend(child_failures)
    elif isinstance(value, list):
        for child in value:
            child_values, child_failures = find_workflow_string_values(
                child, path, field
            )
            values.extend(child_values)
            failures.extend(child_failures)
    return values, failures


def repository_workflow_documents(
    state: YamlRepositoryState,
) -> list[tuple[Path, object]]:
    workflow_root = Path(".github/workflows")
    return [
        (relative, document)
        for relative, document in sorted(state.documents.items())
        if relative.parent == workflow_root and relative not in state.invalid_paths
    ]


def collect_workflow_run_commands(
    root: Path,
    yaml_state: YamlRepositoryState | None = None,
) -> tuple[list[tuple[Path, str]], list[Failure]]:

    commands = []
    state, failures = acquire_yaml_state(root, yaml_state)
    workflows = root / ".github" / "workflows"
    if not workflows.is_dir() or not state.available:
        return commands, failures
    for relative, document in repository_workflow_documents(state):
        document_commands, document_failures = find_workflow_string_values(
            document, relative, "run"
        )
        commands.extend(document_commands)
        failures.extend(document_failures)
    return commands, failures


def workflow_trigger_names(triggers: object) -> set[str]:
    if isinstance(triggers, str):
        return {triggers}
    if isinstance(triggers, list):
        return {trigger for trigger in triggers if isinstance(trigger, str)}
    if isinstance(triggers, dict):
        return {trigger for trigger in triggers if isinstance(trigger, str)}
    return set()


def check_workflow_security(state: YamlRepositoryState) -> list[Failure]:
    failures = []
    documents = repository_workflow_documents(state)
    workflow_paths = {relative for relative, _ in documents}
    for relative in sorted(workflow_paths.difference(APPROVED_WORKFLOW_PATHS)):
        failures.append(Failure(relative, "is not registered as a reviewed workflow"))

    for relative, document in documents:
        if not isinstance(document, dict):
            failures.append(Failure(relative, "must contain a YAML mapping"))
            continue
        if document.get("permissions") != {"contents": "read"}:
            failures.append(
                Failure(
                    relative,
                    "must grant only read access to repository contents",
                )
            )
        if "pull_request_target" in workflow_trigger_names(document.get("on")):
            failures.append(
                Failure(relative, "must not use the pull_request_target event")
            )
        jobs = document.get("jobs")
        if isinstance(jobs, dict):
            for job in jobs.values():
                if isinstance(job, dict) and "permissions" in job:
                    failures.append(
                        Failure(
                            relative,
                            "must not override permissions at job level",
                        )
                    )

        actions, action_failures = find_workflow_string_values(
            document, relative, "uses"
        )
        failures.extend(action_failures)
        for _, action in actions:
            if not FULL_COMMIT_ACTION.fullmatch(action):
                failures.append(
                    Failure(
                        relative,
                        f"uses an action without a full commit pin: {action}",
                    )
                )
            elif action not in APPROVED_ACTIONS:
                failures.append(
                    Failure(relative, f"uses unregistered actions: {action}")
                )
    return failures


def check_ci_workflow(
    root: Path, yaml_state: YamlRepositoryState | None = None
) -> list[Failure]:
    state, failures = acquire_yaml_state(root, yaml_state)
    if not state.available:
        return failures
    failures.extend(check_workflow_security(state))
    path = root / ".github" / "workflows" / "repository-checks.yml"
    relative = path.relative_to(root)
    if not path.is_file() or relative in state.invalid_paths:
        return failures
    document = state.documents.get(relative)
    if not isinstance(document, dict):
        return [*failures, Failure(relative, "must contain a YAML mapping")]

    all_run_commands, command_failures = collect_workflow_run_commands(root, state)
    failures.extend(command_failures)
    for workflow_path, command in all_run_commands:
        if command not in REQUIRED_CI_COMMANDS:
            failures.append(
                Failure(workflow_path, f"uses an unregistered command: {command}")
            )
    for command in sorted(REQUIRED_CI_COMMANDS):
        occurrences = [
            workflow_path
            for workflow_path, candidate in all_run_commands
            if candidate == command
        ]
        if len(occurrences) > 1:
            locations = ", ".join(str(location) for location in occurrences)
            failures.append(
                Failure(
                    Path(".github/workflows"),
                    f"runs registered command more than once: {command} ({locations})",
                )
            )
    if document != EXPECTED_REPOSITORY_CHECKS_WORKFLOW:
        failures.append(
            Failure(
                relative,
                "must match the complete reviewed executable workflow definition",
            )
        )
    return failures


def visible_markdown_text(text: str) -> str:
    return re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)


def markdown_table_rows(text: str, heading: str) -> list[list[str]]:
    visible_text = visible_markdown_text(text)
    heading_match = re.search(
        rf"^##\s+{re.escape(heading)}\s*$", visible_text, re.MULTILINE
    )
    if heading_match is None:
        return []
    next_heading = re.search(
        r"^##\s+", visible_text[heading_match.end() :], re.MULTILINE
    )
    section_end = (
        heading_match.end() + next_heading.start()
        if next_heading is not None
        else len(visible_text)
    )
    rows = []
    for line in visible_text[heading_match.end() : section_end].splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or not stripped.endswith("|"):
            continue
        cells = [cell.strip() for cell in stripped[1:-1].split("|")]
        if cells and not all(set(cell) <= {"-", ":", " "} for cell in cells):
            rows.append(cells)
    return rows[1:] if rows else []


def markdown_code_literal(cell: str) -> str | None:
    match = re.fullmatch(r"`([^`]+)`", cell.strip())
    return match.group(1) if match is not None else None


def check_ci_command_documentation(root: Path) -> list[Failure]:
    path = root / "docs" / "development.md"
    if not path.is_file():
        return []
    text = path.read_text(encoding="utf-8")
    documented_commands = {
        command
        for row in markdown_table_rows(text, "Configured commands")
        if len(row) >= 2 and (command := markdown_code_literal(row[1])) is not None
    }
    missing_commands = sorted(
        command
        for command in REQUIRED_CI_COMMANDS
        if command not in documented_commands
    )
    if not missing_commands:
        return []
    return [
        Failure(
            path.relative_to(root),
            f"does not document configured CI commands: {', '.join(missing_commands)}",
        )
    ]


def normalized_package_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_locked_requirements(
    path: Path,
) -> tuple[dict[str, tuple[str, str]], list[Failure]]:
    dependencies = {}
    failures = []
    current_name = None
    current_hashes = set()
    requirement_pattern = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s\\]+)\s+\\$")
    hash_pattern = re.compile(r"^--hash=sha256:([0-9a-f]{64})(\s+\\)?$")
    for line_number, raw_line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            if current_name is not None:
                failures.append(
                    Failure(
                        Path(path.name),
                        f"interrupts the continued entry for {current_name} "
                        f"on line {line_number}",
                    )
                )
                current_name = None
                current_hashes = set()
            continue
        requirement_match = requirement_pattern.fullmatch(line)
        if requirement_match is not None:
            if current_name is not None:
                failures.append(
                    Failure(
                        Path(path.name),
                        f"starts {requirement_match.group(1)} before the continued "
                        f"entry for {current_name} is complete",
                    )
                )
            display_name, version = requirement_match.groups()
            normalized_name = normalized_package_name(display_name)
            if normalized_name in dependencies:
                failures.append(
                    Failure(Path(path.name), f"duplicates dependency {display_name}")
                )
            else:
                dependencies[normalized_name] = (display_name, version)
            current_name = display_name
            current_hashes = set()
            continue
        hash_match = hash_pattern.fullmatch(line)
        if hash_match is not None and current_name is not None:
            digest, continuation = hash_match.groups()
            if digest in current_hashes:
                failures.append(
                    Failure(Path(path.name), f"duplicates a hash for {current_name}")
                )
            current_hashes.add(digest)
            if continuation is None:
                current_name = None
                current_hashes = set()
            continue
        failures.append(
            Failure(
                Path(path.name),
                f"contains an unsupported entry on line {line_number}",
            )
        )
    if current_name is not None:
        failures.append(
            Failure(
                Path(path.name),
                f"ends with an unfinished continuation for {current_name}",
            )
        )
    return dependencies, failures


def check_dependency_records(root: Path) -> list[Failure]:
    documentation = root / "docs" / "dependencies.md"
    lockfile = root / "requirements-dev.lock"
    if not documentation.is_file() or not lockfile.is_file():
        return []

    rows = {
        dependency: row
        for row in markdown_table_rows(
            documentation.read_text(encoding="utf-8"), "Direct third-party tools"
        )
        if row and (dependency := markdown_code_literal(row[0])) is not None
    }
    failures = []
    for action, release in APPROVED_ACTIONS.items():
        repository, commit = action.split("@", 1)
        row = rows.get(repository)
        selected_version = row[2] if row is not None and len(row) >= 3 else ""
        if commit not in selected_version or release not in selected_version:
            failures.append(
                Failure(
                    documentation.relative_to(root),
                    f"does not visibly record approved action {repository} "
                    f"at {commit} ({release})",
                )
            )

    locked_dependencies, lock_failures = parse_locked_requirements(lockfile)
    failures.extend(lock_failures)
    documented_dependencies = {}
    for dependency, row in rows.items():
        selected_version = row[2] if len(row) >= 3 else ""
        if "requirements-dev.lock" not in selected_version:
            continue
        versions = re.findall(r"`([^`]+)`", selected_version)
        if versions:
            documented_dependencies[normalized_package_name(dependency)] = (
                dependency,
                versions[0],
            )

    missing_documentation = sorted(
        name for name in locked_dependencies if name not in documented_dependencies
    )
    missing_lock_entries = sorted(
        name for name in documented_dependencies if name not in locked_dependencies
    )
    mismatched_versions = sorted(
        name
        for name in locked_dependencies.keys() & documented_dependencies.keys()
        if locked_dependencies[name][1] != documented_dependencies[name][1]
    )
    if missing_documentation:
        failures.append(
            Failure(
                documentation.relative_to(root),
                "does not document locked dependencies: "
                + ", ".join(missing_documentation),
            )
        )
    if missing_lock_entries:
        failures.append(
            Failure(
                lockfile.relative_to(root),
                "is missing documented dependencies: "
                + ", ".join(missing_lock_entries),
            )
        )
    if mismatched_versions:
        failures.append(
            Failure(
                lockfile.relative_to(root),
                "does not match documented dependency versions: "
                + ", ".join(mismatched_versions),
            )
        )
    return failures


def check_required_files(root: Path) -> list[Failure]:
    failures = []
    for name in sorted(REQUIRED_FILES):
        if not (root / name).is_file():
            failures.append(Failure(Path(name), "required repository file is missing"))
    return failures


def active_rule_lines(text: str) -> set[str]:
    return {
        stripped
        for line in text.splitlines()
        if (stripped := line.strip()) and not stripped.startswith(("#", ";"))
    }


def parse_editorconfig(text: str) -> dict[str, dict[str, str]]:
    sections: dict[str, dict[str, str]] = {"": {}}
    current_section = ""
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith(("#", ";")):
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            current_section = stripped[1:-1].strip()
            sections.setdefault(current_section, {})
            continue
        if "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        sections[current_section][key.strip()] = value.strip()
    return sections


def missing_exact_rules(text: str, required: set[str]) -> list[str]:
    return sorted(required.difference(active_rule_lines(text)))


def check_required_file_content(root: Path) -> list[Failure]:
    failures = []
    editorconfig = root / ".editorconfig"
    if editorconfig.is_file():
        sections = parse_editorconfig(editorconfig.read_text(encoding="utf-8"))
        missing = []
        for section, settings in REQUIRED_EDITORCONFIG_SETTINGS.items():
            actual = sections.get(section, {})
            missing.extend(
                f"[{section or 'global'}] {key} = {value}"
                for key, value in settings.items()
                if actual.get(key) != value
            )
        if missing:
            failures.append(
                Failure(
                    Path(".editorconfig"),
                    "is missing required active settings: " + ", ".join(missing),
                )
            )

    for name, required in (
        (".gitattributes", REQUIRED_GITATTRIBUTE_RULES),
        (".gitignore", REQUIRED_GITIGNORE_RULES),
    ):
        path = root / name
        if not path.is_file():
            continue
        missing = missing_exact_rules(path.read_text(encoding="utf-8"), required)
        if missing:
            failures.append(
                Failure(
                    Path(name),
                    "is missing required active rules: " + ", ".join(missing),
                )
            )

    pull_request_template = root / ".github" / "pull_request_template.md"
    if pull_request_template.is_file():
        text = pull_request_template.read_text(encoding="utf-8")
        visible_text = visible_markdown_text(text)
        headings = {
            match.group(1).strip().rstrip("#").strip()
            for match in re.finditer(r"^##\s+(.+)$", visible_text, re.MULTILINE)
        }
        missing = sorted(REQUIRED_PULL_REQUEST_HEADINGS.difference(headings))
        missing.extend(
            sorted(
                required
                for required in REQUIRED_PULL_REQUEST_TEXT
                if required not in visible_text
            )
        )
        if missing:
            failures.append(
                Failure(
                    Path(".github/pull_request_template.md"),
                    "is missing required active template content: "
                    + ", ".join(missing),
                )
            )

    ruff_config = root / "ruff.toml"
    if ruff_config.is_file():
        try:
            document = tomllib.loads(ruff_config.read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError as error:
            failures.append(
                Failure(Path("ruff.toml"), f"contains invalid TOML: {error}")
            )
        else:
            if document != EXPECTED_RUFF_CONFIGURATION:
                failures.append(
                    Failure(
                        Path("ruff.toml"),
                        "must match the complete reviewed formatter and linter "
                        "configuration",
                    )
                )
    return failures


def check_quality_policy_consumers(root: Path) -> list[Failure]:
    failures = []
    for name in sorted(QUALITY_POLICY_CONSUMERS):
        path = root / name
        if not path.is_file():
            continue
        visible_text = visible_markdown_text(path.read_text(encoding="utf-8"))
        if "docs/quality.md" not in visible_text:
            failures.append(
                Failure(
                    path.relative_to(root),
                    "must direct its implementation or review role to docs/quality.md",
                )
            )
    return failures


def check_instruction_review_routing(root: Path) -> list[Failure]:
    failures = []
    for name, reference in sorted(INSTRUCTION_REVIEW_ROUTES.items()):
        path = root / name
        if not path.is_file():
            continue
        visible_text = visible_markdown_text(path.read_text(encoding="utf-8"))
        if reference not in visible_text:
            failures.append(
                Failure(
                    path.relative_to(root),
                    "must visibly route instruction changes to "
                    "docs/agent-instruction-review.md",
                )
            )
    return failures


def check_timeless_documentation(root: Path) -> list[Failure]:
    failures = []
    paths = [root / name for name in TIMELESS_DOCUMENTS]
    skills_root = root / ".agents" / "skills"
    if skills_root.is_dir():
        paths.extend(skills_root.glob("*/SKILL.md"))
    for path in sorted(paths):
        if not path.is_file():
            continue
        text = " ".join(path.read_text(encoding="utf-8").split())
        for pattern in PROJECT_PROGRESS_PATTERNS:
            for match in pattern.finditer(text):
                phrase = " ".join(match.group(0).split())
                failures.append(
                    Failure(
                        path.relative_to(root),
                        f"uses project-progress wording in durable documentation: {phrase!r}",
                    )
                )
    return failures


def check_repository(root: Path) -> list[Failure]:
    yaml_state = load_yaml_repository(root)
    checks_before_yaml = (
        check_required_files,
        check_required_file_content,
        check_text_format,
        check_markdown_links,
    )
    checks_after_yaml = (
        check_skills,
        check_quality_policy_consumers,
        check_instruction_review_routing,
        check_ci_command_documentation,
        check_dependency_records,
        check_timeless_documentation,
    )
    failures = [failure for check in checks_before_yaml for failure in check(root)]
    failures.extend(check_yaml_syntax(root, yaml_state))
    if yaml_state.available:
        failures.extend(check_issue_forms(root, yaml_state))
        failures.extend(check_ci_workflow(root, yaml_state))
    failures.extend(failure for check in checks_after_yaml for failure in check(root))
    return failures


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    failures = check_repository(root)
    if failures:
        for failure in failures:
            print(f"{failure.path}: {failure.message}")
        print(f"Repository validation failed with {len(failures)} problem(s).")
        return 1
    print("Repository validation passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
