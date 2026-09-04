import ast
import importlib.util
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_repository.py"
SPEC = importlib.util.spec_from_file_location("check_repository", SCRIPT)
CHECKS = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = CHECKS
SPEC.loader.exec_module(CHECKS)

RUNNER_SCRIPT = SCRIPT.parents[1] / "scripts" / "run_tests.py"
RUNNER_SPEC = importlib.util.spec_from_file_location("run_tests", RUNNER_SCRIPT)
RUNNER = importlib.util.module_from_spec(RUNNER_SPEC)
assert RUNNER_SPEC.loader is not None
sys.modules[RUNNER_SPEC.name] = RUNNER
RUNNER_SPEC.loader.exec_module(RUNNER)


class RepositoryCheckTests(unittest.TestCase):
    def write_valid_skill(self, root, name):
        skill = root / ".agents" / "skills" / name
        skill.mkdir(parents=True, exist_ok=True)
        (skill / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: Test.\n---\n\nRead docs/agent-workflow.md.\n",
            encoding="utf-8",
        )

    def write_issue_form(
        self, root, name="bug.yml", label=None, omitted=None, required=True
    ):
        forms = root / ".github" / "ISSUE_TEMPLATE"
        forms.mkdir(parents=True, exist_ok=True)
        requirements = CHECKS.ISSUE_FORM_REQUIREMENTS[name]
        identifiers = sorted(CHECKS.REQUIRED_ISSUE_FIELDS | requirements["fields"])
        document = {
            "name": "Issue form",
            "description": "Test form",
            "labels": [label or requirements["label"]],
            "body": [
                {
                    "type": "textarea",
                    "id": identifier,
                    "attributes": {"label": identifier},
                    "validations": {"required": required},
                }
                for identifier in identifiers
                if identifier != omitted
            ],
        }
        (forms / name).write_text(
            CHECKS.yaml.safe_dump(document, sort_keys=False), encoding="utf-8"
        )

    def copy_repository_workflow(self, root):
        workflow = root / ".github" / "workflows" / "repository-checks.yml"
        workflow.parent.mkdir(parents=True)
        source = SCRIPT.parents[1] / ".github" / "workflows" / "repository-checks.yml"
        workflow.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
        return workflow

    def write_additional_workflow(self, root, body):
        workflow = root / ".github" / "workflows" / "additional.yml"
        workflow.parent.mkdir(parents=True, exist_ok=True)
        workflow.write_text(body, encoding="utf-8")
        return workflow

    def assert_workflow_mutation_rejected(self, original, replacement):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workflow = self.copy_repository_workflow(root)
            text = workflow.read_text(encoding="utf-8")
            self.assertIn(original, text)
            workflow.write_text(
                text.replace(original, replacement, 1), encoding="utf-8"
            )
            failures = CHECKS.check_ci_workflow(root)
            self.assertTrue(
                any("complete reviewed executable" in item.message for item in failures)
            )

    def test_text_format_reports_trailing_whitespace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "bad.md").write_text("Bad line  \n", encoding="utf-8")
            failures = CHECKS.check_text_format(root)
            self.assertTrue(
                any("trailing whitespace" in item.message for item in failures)
            )

    def test_markdown_links_report_missing_local_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "README.md").write_text(
                "[Missing](docs/missing.md)\n", encoding="utf-8"
            )
            failures = CHECKS.check_markdown_links(root)
            self.assertEqual(len(failures), 1)
            self.assertIn("docs/missing.md", failures[0].message)

    def test_markdown_links_reject_targets_outside_repository(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "repository"
            root.mkdir()
            (root / "README.md").write_text("[Outside](../)\n", encoding="utf-8")
            failures = CHECKS.check_markdown_links(root)
            self.assertTrue(
                any("outside the repository" in item.message for item in failures)
            )

    def test_markdown_image_links_report_missing_local_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "README.md").write_text(
                "![Missing](docs/missing.png)\n", encoding="utf-8"
            )
            failures = CHECKS.check_markdown_links(root)
            self.assertEqual(len(failures), 1)

    def test_skill_name_must_match_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            skill = root / ".agents" / "skills" / "expected"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text(
                "---\nname: different\ndescription: Test.\n---\n\nRead docs/agent-workflow.md.\n",
                encoding="utf-8",
            )
            failures = CHECKS.check_skills(root)
            self.assertTrue(any("does not match" in item.message for item in failures))

    def test_skill_frontmatter_must_be_valid_yaml(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in CHECKS.REQUIRED_SKILLS:
                self.write_valid_skill(root, name)
            skill = root / ".agents" / "skills" / sorted(CHECKS.REQUIRED_SKILLS)[0]
            (skill / "SKILL.md").write_text(
                "---\nname: broken\ndescription: [unterminated\n---\n\n"
                "Read docs/agent-workflow.md.\n",
                encoding="utf-8",
            )
            declarations = "\n".join(
                f"Use `${name}`." for name in sorted(CHECKS.REQUIRED_SKILLS)
            )
            (root / "AGENTS.md").write_text(declarations + "\n", encoding="utf-8")
            failures = CHECKS.check_skills(root)
            self.assertTrue(
                any("invalid frontmatter YAML" in item.message for item in failures)
            )

    def test_skill_routing_and_workflow_references_must_be_visible(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in CHECKS.REQUIRED_SKILLS:
                self.write_valid_skill(root, name)
            declarations = "\n".join(
                f"Use `${name}`." for name in sorted(CHECKS.REQUIRED_SKILLS)
            )
            (root / "AGENTS.md").write_text(
                f"<!--\n{declarations}\n-->\n", encoding="utf-8"
            )
            failures = CHECKS.check_skills(root)
            self.assertTrue(
                any(
                    "does not declare installed skills" in item.message
                    for item in failures
                )
            )

            (root / "AGENTS.md").write_text(declarations + "\n", encoding="utf-8")
            skill = root / ".agents" / "skills" / sorted(CHECKS.REQUIRED_SKILLS)[0]
            (skill / "SKILL.md").write_text(
                "---\nname: "
                + skill.name
                + "\ndescription: Test.\n---\n\n"
                + "<!-- Read docs/agent-workflow.md. -->\n",
                encoding="utf-8",
            )
            failures = CHECKS.check_skills(root)
            self.assertTrue(
                any(
                    item.path == (skill / "SKILL.md").relative_to(root)
                    and "common agent workflow" in item.message
                    for item in failures
                )
            )

    def test_required_documents_cannot_disappear(self):
        with tempfile.TemporaryDirectory() as directory:
            failures = CHECKS.check_required_files(Path(directory))
            self.assertEqual(len(failures), len(CHECKS.REQUIRED_FILES))

    def test_required_files_include_every_timeless_document(self):
        self.assertTrue(CHECKS.TIMELESS_DOCUMENTS.issubset(CHECKS.REQUIRED_FILES))

    def test_implementation_and_review_roles_must_link_quality_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in CHECKS.QUALITY_POLICY_CONSUMERS:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("Follow docs/quality.md.\n", encoding="utf-8")
            self.assertEqual(CHECKS.check_quality_policy_consumers(root), [])

            missing_reference = root / ".agents/skills/tabgrad-review/SKILL.md"
            missing_reference.write_text("Review the change.\n", encoding="utf-8")
            failures = CHECKS.check_quality_policy_consumers(root)
            self.assertEqual(len(failures), 1)
            self.assertEqual(failures[0].path, missing_reference.relative_to(root))

            missing_reference.write_text(
                "Review the change.\n<!-- docs/quality.md -->\n", encoding="utf-8"
            )
            failures = CHECKS.check_quality_policy_consumers(root)
            self.assertEqual(len(failures), 1)
            self.assertEqual(failures[0].path, missing_reference.relative_to(root))

    def test_instruction_review_routes_must_remain_visible(self):
        source_root = SCRIPT.parents[1]
        for name, reference in CHECKS.INSTRUCTION_REVIEW_ROUTES.items():
            with (
                self.subTest(path=name),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = Path(directory)
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                source = (source_root / name).read_text(encoding="utf-8")
                path.write_text(
                    source.replace(reference, f"<!-- {reference} -->"),
                    encoding="utf-8",
                )
                failures = CHECKS.check_instruction_review_routing(root)
                self.assertEqual(len(failures), 1)
                self.assertEqual(failures[0].path, Path(name))

    def test_durable_documentation_rejects_project_progress_wording(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "README.md").write_text(
                "# Project\n\nThe runtime is not yet\nimplemented. "
                "A GPU backend will be\nadded in a later phase. "
                "A second integration is planned for a future stage.\n",
                encoding="utf-8",
            )
            (root / "CONTRIBUTING.md").write_text(
                "The browser runtime will be added in a later phase.\n",
                encoding="utf-8",
            )
            skill = root / ".agents" / "skills" / "example" / "SKILL.md"
            skill.parent.mkdir(parents=True)
            skill.write_text(
                "A compatibility layer will be implemented later.\n",
                encoding="utf-8",
            )
            failures = CHECKS.check_timeless_documentation(root)
            self.assertEqual(len(failures), 5)
            self.assertTrue(
                all("project-progress wording" in item.message for item in failures)
            )

    def test_durable_documentation_allows_operational_check_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            docs = root / "docs"
            docs.mkdir(parents=True)
            (docs / "continuous-integration.md").write_text(
                "A check that has not yet completed is not a pass. "
                "A required check will be configured only after its local command passes. "
                "The CPU backend will be configured only after its local check passes.\n",
                encoding="utf-8",
            )
            (docs / "dependencies.md").write_text(
                "When removal is planned, verify the lockfile.\n",
                encoding="utf-8",
            )
            (docs / "compatibility.md").write_text(
                "The WebGPU backend is planned for removal in release 2.0.\n",
                encoding="utf-8",
            )
            (docs / "project-management.md").write_text(
                "A feature issue describes the feature that will be implemented.\n",
                encoding="utf-8",
            )
            (docs / "documentation.md").write_text(
                "Once an issue exists, link the evidence that it contains.\n",
                encoding="utf-8",
            )
            self.assertEqual(CHECKS.check_timeless_documentation(root), [])

    def test_operational_state_language_is_outside_the_durable_prose_check(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "docs" / "project-management.md"
            path.parent.mkdir(parents=True)
            path.write_text("Record the issue's current status.\n", encoding="utf-8")
            self.assertEqual(CHECKS.check_timeless_documentation(root), [])

    def test_workflow_is_a_required_repository_file(self):
        self.assertIn(".github/workflows/repository-checks.yml", CHECKS.REQUIRED_FILES)

    def test_validator_tests_are_a_required_repository_file(self):
        self.assertIn("tests/test_repository_checks.py", CHECKS.REQUIRED_FILES)

    def test_foundation_configuration_is_required(self):
        expected = {
            ".editorconfig",
            ".gitattributes",
            ".github/pull_request_template.md",
            ".gitignore",
            "ruff.toml",
        }
        self.assertTrue(expected.issubset(CHECKS.REQUIRED_FILES))

    def test_exact_foundation_rules_cannot_be_commented_out(self):
        source_root = SCRIPT.parents[1]
        requirements = {
            ".gitattributes": CHECKS.REQUIRED_GITATTRIBUTE_RULES,
            ".gitignore": CHECKS.REQUIRED_GITIGNORE_RULES,
        }
        for name, required_rules in requirements.items():
            for rule in required_rules:
                with (
                    self.subTest(path=name, rule=rule),
                    tempfile.TemporaryDirectory() as directory,
                ):
                    root = Path(directory)
                    target = root / name
                    source_lines = (
                        (source_root / name).read_text(encoding="utf-8").splitlines()
                    )
                    source_lines[source_lines.index(rule)] = f"# {rule}"
                    target.write_text("\n".join(source_lines) + "\n", encoding="utf-8")
                    failures = CHECKS.check_required_file_content(root)
                    self.assertTrue(any(item.path == Path(name) for item in failures))

    def test_editorconfig_requires_settings_in_their_own_sections(self):
        source_root = SCRIPT.parents[1]
        for section, settings in CHECKS.REQUIRED_EDITORCONFIG_SETTINGS.items():
            for key, value in settings.items():
                with (
                    self.subTest(section=section, key=key),
                    tempfile.TemporaryDirectory() as directory,
                ):
                    root = Path(directory)
                    target = root / ".editorconfig"
                    source = (source_root / ".editorconfig").read_text(encoding="utf-8")
                    source = source.replace(f"{key} = {value}", f"# {key} = {value}", 1)
                    source += f"\n[unrelated]\n{key} = {value}\n"
                    target.write_text(source, encoding="utf-8")
                    failures = CHECKS.check_required_file_content(root)
                    self.assertTrue(
                        any(item.path == Path(".editorconfig") for item in failures)
                    )

    def test_pull_request_template_requires_visible_headings_and_rules(self):
        source_root = SCRIPT.parents[1]
        requirements = [
            *(f"## {heading}" for heading in CHECKS.REQUIRED_PULL_REQUEST_HEADINGS),
            *CHECKS.REQUIRED_PULL_REQUEST_TEXT,
        ]
        for required in requirements:
            with (
                self.subTest(required=required),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = Path(directory)
                target = root / ".github" / "pull_request_template.md"
                target.parent.mkdir(parents=True)
                source = (
                    source_root / ".github" / "pull_request_template.md"
                ).read_text(encoding="utf-8")
                source = source.replace(required, f"<!-- {required} -->")
                target.write_text(source, encoding="utf-8")
                failures = CHECKS.check_required_file_content(root)
                self.assertTrue(
                    any(
                        item.path == Path(".github/pull_request_template.md")
                        for item in failures
                    )
                )

    def test_ruff_settings_are_parsed_as_toml(self):
        source_root = SCRIPT.parents[1]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "ruff.toml"
            source = (source_root / "ruff.toml").read_text(encoding="utf-8")
            target.write_text(
                source.replace(
                    'target-version = "py311"', '# target-version = "py311"'
                ),
                encoding="utf-8",
            )
            failures = CHECKS.check_required_file_content(root)
            self.assertTrue(any(item.path == Path("ruff.toml") for item in failures))

    def test_ruff_configuration_cannot_exclude_maintained_python(self):
        source_root = SCRIPT.parents[1]
        source = (source_root / "ruff.toml").read_text(encoding="utf-8")
        documents = (
            'force-exclude = true\nexclude = ["scripts", "tests"]\n' + source,
            source.replace(
                "[lint]\n",
                '[lint]\nignore = ["B", "E4", "E7", "E9", "F", "I", "RUF", "UP"]\n',
            ),
        )
        for document in documents:
            with (
                self.subTest(document=document),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = Path(directory)
                target = root / "ruff.toml"
                target.write_text(document, encoding="utf-8")
                failures = CHECKS.check_required_file_content(root)
                self.assertTrue(
                    any(item.path == Path("ruff.toml") for item in failures)
                )

    def test_test_runner_rejects_zero_discovered_tests(self):
        with tempfile.TemporaryDirectory() as directory:
            output = io.StringIO()
            result = RUNNER.run_tests(Path(directory), stream=output)
            self.assertEqual(result, 2)
            self.assertIn("zero tests", output.getvalue())

    def test_test_runner_does_not_reuse_discovery_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            populated = root / "populated"
            populated.mkdir()
            (populated / "test_example.py").write_text(
                "import unittest\n\n"
                "class ExampleTest(unittest.TestCase):\n"
                "    def test_example(self):\n"
                "        self.assertTrue(True)\n",
                encoding="utf-8",
            )
            self.assertEqual(RUNNER.run_tests(populated, stream=io.StringIO()), 0)

            empty = root / "empty"
            empty.mkdir()
            output = io.StringIO()
            self.assertEqual(RUNNER.run_tests(empty, stream=output), 2)
            self.assertIn("zero tests", output.getvalue())

    def test_test_runner_isolates_modules_between_invocations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("first", "second"):
                suite = root / name
                suite.mkdir()
                (suite / "test_tabgrad_runner_same_name.py").write_text(
                    "import unittest\n\n"
                    "class ExampleTest(unittest.TestCase):\n"
                    "    def test_example(self):\n"
                    "        self.assertTrue(True)\n",
                    encoding="utf-8",
                )
                self.assertEqual(RUNNER.run_tests(suite, stream=io.StringIO()), 0)
            self.assertNotIn("test_tabgrad_runner_same_name", sys.modules)

    def test_required_skills_cannot_disappear(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".agents" / "skills").mkdir(parents=True)
            failures = CHECKS.check_skills(root)
            self.assertTrue(
                any("missing required skills" in item.message for item in failures)
            )

    def test_installed_skill_names_include_only_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(CHECKS.installed_skill_names(root), set())
            skills = root / ".agents" / "skills"
            (skills / "installed").mkdir(parents=True)
            (skills / "not-a-skill.txt").write_text("text\n", encoding="utf-8")
            self.assertEqual(CHECKS.installed_skill_names(root), {"installed"})

    def test_agents_must_declare_every_installed_skill(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in CHECKS.REQUIRED_SKILLS:
                self.write_valid_skill(root, name)
            declarations = "\n".join(
                f"Use `${name}`."
                for name in sorted(
                    CHECKS.REQUIRED_SKILLS.difference({"tabgrad-review"})
                )
            )
            (root / "AGENTS.md").write_text(declarations, encoding="utf-8")
            failures = CHECKS.check_skills(root)
            self.assertTrue(
                any(
                    "does not declare installed skills" in item.message
                    for item in failures
                )
            )

    def test_agents_cannot_declare_a_missing_skill(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in CHECKS.REQUIRED_SKILLS:
                self.write_valid_skill(root, name)
            declarations = "\n".join(
                f"Use `${name}`." for name in sorted(CHECKS.REQUIRED_SKILLS)
            )
            (root / "AGENTS.md").write_text(
                f"{declarations}\nUse `$tabgrad-missing`.\n", encoding="utf-8"
            )
            failures = CHECKS.check_skills(root)
            self.assertTrue(
                any("without directories" in item.message for item in failures)
            )

    def test_required_issue_forms_cannot_disappear(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            forms = root / ".github" / "ISSUE_TEMPLATE"
            forms.mkdir(parents=True)
            (forms / "config.yml").write_text(
                "blank_issues_enabled: false\nsecurity/advisories/new: true\n",
                encoding="utf-8",
            )
            failures = CHECKS.check_issue_forms(root)
            self.assertTrue(
                any("missing required issue forms" in item.message for item in failures)
            )

    def test_unregistered_issue_forms_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            forms = root / ".github" / "ISSUE_TEMPLATE"
            forms.mkdir(parents=True)
            (forms / "unknown.yml").write_text("name: Unknown\n", encoding="utf-8")
            failures = CHECKS.check_issue_forms(root)
            self.assertTrue(
                any("unregistered issue forms" in item.message for item in failures)
            )

    def test_invalid_yaml_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workflow = root / ".github" / "workflows" / "bad.yml"
            workflow.parent.mkdir(parents=True)
            workflow.write_text("name: [unterminated\n", encoding="utf-8")
            failures = CHECKS.check_yaml_syntax(root)
            self.assertTrue(any("invalid YAML" in item.message for item in failures))

    def test_invalid_yaml_does_not_cascade_into_semantic_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            form = root / ".github" / "ISSUE_TEMPLATE" / "bug.yml"
            form.parent.mkdir(parents=True)
            form.write_text("name: [unterminated\n", encoding="utf-8")
            yaml_state = CHECKS.load_yaml_repository(root)
            failures = [
                *CHECKS.check_yaml_syntax(root, yaml_state),
                *CHECKS.check_issue_forms(root, yaml_state),
            ]
            form_failures = [
                item for item in failures if item.path == form.relative_to(root)
            ]
            self.assertEqual(len(form_failures), 1)
            self.assertIn("invalid YAML", form_failures[0].message)

    def test_invalid_yaml_root_does_not_cascade_into_workflow_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workflow = root / ".github" / "workflows" / "scalar.yml"
            workflow.parent.mkdir(parents=True)
            workflow.write_text("scalar\n", encoding="utf-8")
            yaml_state = CHECKS.load_yaml_repository(root)
            failures = [
                *CHECKS.check_yaml_syntax(root, yaml_state),
                *CHECKS.check_ci_workflow(root, yaml_state),
            ]
            workflow_failures = [
                item for item in failures if item.path == workflow.relative_to(root)
            ]
            self.assertEqual(len(workflow_failures), 1)
            self.assertIn("at its root", workflow_failures[0].message)

    def test_recursive_yaml_alias_is_rejected_without_crashing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workflow = root / ".github" / "workflows" / "recursive.yml"
            workflow.parent.mkdir(parents=True)
            workflow.write_text("cycle: &cycle\n  self: *cycle\n", encoding="utf-8")
            yaml_state = CHECKS.load_yaml_repository(root)
            failures = [
                *CHECKS.check_yaml_syntax(root, yaml_state),
                *CHECKS.check_ci_workflow(root, yaml_state),
            ]
            workflow_failures = [
                item for item in failures if item.path == workflow.relative_to(root)
            ]
            self.assertEqual(len(workflow_failures), 1)
            self.assertIn("recursive YAML alias", workflow_failures[0].message)

    def test_nonrecursive_yaml_alias_occurrences_are_preserved(self):
        document = CHECKS.yaml.load(
            "shared: &shared\n  run: echo shared\nleft: *shared\nright: *shared\n",
            Loader=CHECKS.RepositoryYamlLoader,
        )
        commands, failures = CHECKS.find_workflow_string_values(
            document, Path("workflow.yml"), "run"
        )
        self.assertEqual(failures, [])
        self.assertEqual(commands.count((Path("workflow.yml"), "echo shared")), 3)

    def test_aggregate_missing_yaml_dependency_reports_one_root_cause(self):
        source_root = SCRIPT.parents[1]
        with mock.patch.object(CHECKS, "yaml", None):
            failures = CHECKS.check_repository(source_root)
        self.assertEqual(
            failures,
            [
                CHECKS.Failure(
                    Path("requirements-dev.lock"),
                    "development dependencies are not installed; "
                    "follow docs/development.md",
                )
            ],
        )

    def test_aggregate_parses_each_yaml_source_once(self):
        source_root = SCRIPT.parents[1]
        yaml_files = [
            path
            for path in CHECKS.repository_files(source_root)
            if path.suffix.lower() in {".yaml", ".yml"}
        ]
        skill_files = list((source_root / ".agents" / "skills").glob("*/SKILL.md"))
        with mock.patch.object(CHECKS.yaml, "load", wraps=CHECKS.yaml.load) as load:
            failures = CHECKS.check_repository(source_root)
        self.assertEqual(failures, [])
        self.assertEqual(load.call_count, len(yaml_files) + len(skill_files))

    def test_yaml_loader_preserves_workflow_keys_and_boolean_values(self):
        source_root = SCRIPT.parents[1]
        state = CHECKS.load_yaml_repository(source_root)
        workflow = state.documents[Path(".github/workflows/repository-checks.yml")]
        issue_config = state.documents[Path(".github/ISSUE_TEMPLATE/config.yml")]
        self.assertIn("on", workflow)
        self.assertIs(workflow["concurrency"]["cancel-in-progress"], True)
        self.assertIs(issue_config["blank_issues_enabled"], False)

    def test_workflow_run_walker_is_not_a_nested_helper(self):
        tree = ast.parse(SCRIPT.read_text(encoding="utf-8"))
        collector = next(
            node
            for node in tree.body
            if isinstance(node, ast.FunctionDef)
            and node.name == "collect_workflow_run_commands"
        )
        nested_helpers = [
            node
            for node in ast.walk(collector)
            if node is not collector and isinstance(node, ast.FunctionDef)
        ]
        self.assertEqual(nested_helpers, [])

    def test_issue_form_must_have_common_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            forms = root / ".github" / "ISSUE_TEMPLATE"
            forms.mkdir(parents=True)
            (forms / "bug.yml").write_text(
                "name: Bug\nlabels:\n  - bug\nbody: []\n", encoding="utf-8"
            )
            failures = CHECKS.check_issue_forms(root)
            self.assertTrue(
                any("missing required fields" in item.message for item in failures)
            )

    def test_issue_form_must_keep_type_specific_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_issue_form(root, omitted="reproduction")
            failures = CHECKS.check_issue_forms(root)
            self.assertTrue(any("reproduction" in item.message for item in failures))

    def test_issue_form_must_keep_exact_type_label(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_issue_form(root, label="type: feature")
            failures = CHECKS.check_issue_forms(root)
            self.assertTrue(any("type: bug" in item.message for item in failures))

    def test_issue_form_fields_must_remain_required(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_issue_form(root, required=False)
            failures = CHECKS.check_issue_forms(root)
            self.assertTrue(any("not required" in item.message for item in failures))

    def test_issue_config_must_link_private_security_reporting(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            forms = root / ".github" / "ISSUE_TEMPLATE"
            forms.mkdir(parents=True)
            (forms / "config.yml").write_text(
                "blank_issues_enabled: false\n", encoding="utf-8"
            )
            failures = CHECKS.check_issue_forms(root)
            self.assertTrue(
                any("private vulnerability" in item.message for item in failures)
            )

    def test_ci_actions_must_use_full_commit_pins(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workflow = self.copy_repository_workflow(root)
            text = workflow.read_text(encoding="utf-8").replace(
                "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
                "actions/checkout@main",
            )
            workflow.write_text(text, encoding="utf-8")
            failures = CHECKS.check_ci_workflow(root)
            self.assertTrue(
                any("without a full commit pin" in item.message for item in failures)
            )

    def test_ci_must_keep_pull_request_trigger(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workflow = self.copy_repository_workflow(root)
            text = workflow.read_text(encoding="utf-8").replace("  pull_request:\n", "")
            workflow.write_text(text, encoding="utf-8")
            failures = CHECKS.check_ci_workflow(root)
            self.assertTrue(
                any("complete reviewed executable" in item.message for item in failures)
            )

    def test_ci_rejects_unregistered_pinned_action(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workflow = self.copy_repository_workflow(root)
            text = workflow.read_text(encoding="utf-8").replace(
                "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
                "actions/checkout@0000000000000000000000000000000000000000",
            )
            workflow.write_text(text, encoding="utf-8")
            failures = CHECKS.check_ci_workflow(root)
            self.assertTrue(
                any("unregistered actions" in item.message for item in failures)
            )

    def test_ci_rejects_job_level_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workflow = self.copy_repository_workflow(root)
            text = workflow.read_text(encoding="utf-8").replace(
                "    name: repository-consistency\n",
                "    name: repository-consistency\n    permissions:\n      contents: write\n",
            )
            workflow.write_text(text, encoding="utf-8")
            failures = CHECKS.check_ci_workflow(root)
            self.assertTrue(any("job level" in item.message for item in failures))

    def test_ci_rejects_additional_unreviewed_jobs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workflow = self.copy_repository_workflow(root)
            text = workflow.read_text(encoding="utf-8")
            text += (
                "\n  unexpected:\n"
                "    permissions:\n"
                "      contents: write\n"
                "    runs-on: ubuntu-latest\n"
                "    steps: []\n"
            )
            workflow.write_text(text, encoding="utf-8")
            failures = CHECKS.check_ci_workflow(root)
            self.assertTrue(
                any("complete reviewed executable" in item.message for item in failures)
            )

    def test_ci_rejects_changes_that_can_neutralize_required_checks(self):
        mutations = (
            (
                "pull request path filter",
                "  pull_request:\n",
                "  pull_request:\n    paths:\n      - docs/**\n",
            ),
            (
                "global concurrency group",
                "  group: repository-checks-${{ github.workflow }}-${{ github.ref }}\n",
                "  group: repository-checks\n",
            ),
            (
                "job error tolerance",
                "    timeout-minutes: 5\n",
                "    timeout-minutes: 5\n    continue-on-error: true\n",
            ),
            (
                "unregistered container",
                "    timeout-minutes: 5\n",
                "    timeout-minutes: 5\n    container: python:latest\n",
            ),
            (
                "secret environment",
                "permissions:\n  contents: read\n",
                "permissions:\n  contents: read\n\n"
                "env:\n  TOKEN: ${{ secrets.TEST_TOKEN }}\n",
            ),
            (
                "step error tolerance",
                "        run: python3 scripts/run_tests.py\n",
                "        run: python3 scripts/run_tests.py\n"
                "        continue-on-error: true\n",
            ),
            (
                "step condition",
                "        run: python3 scripts/run_tests.py\n",
                "        run: python3 scripts/run_tests.py\n        if: false\n",
            ),
            (
                "replacement shell",
                "        run: python3 scripts/run_tests.py\n",
                "        run: python3 scripts/run_tests.py\n        shell: echo {0}\n",
            ),
            (
                "checkout branch override",
                "          persist-credentials: false\n",
                "          persist-credentials: false\n          ref: main\n",
            ),
            (
                "checkout repository override",
                "          persist-credentials: false\n",
                "          persist-credentials: false\n"
                "          repository: owner/other\n",
            ),
            (
                "checkout token override",
                "          persist-credentials: false\n",
                "          persist-credentials: false\n"
                "          token: ${{ secrets.TEST_TOKEN }}\n",
            ),
        )
        for name, original, replacement in mutations:
            with self.subTest(name=name):
                self.assert_workflow_mutation_rejected(original, replacement)

    def test_ci_rejects_unregistered_run_command(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workflow = self.copy_repository_workflow(root)
            text = workflow.read_text(encoding="utf-8").replace(
                "    steps:\n",
                "    steps:\n      - name: Unexpected command\n        run: echo unexpected\n\n",
            )
            workflow.write_text(text, encoding="utf-8")
            failures = CHECKS.check_ci_workflow(root)
            self.assertTrue(
                any("unregistered command" in item.message for item in failures)
            )

    def test_ci_rejects_unregistered_run_command_in_another_workflow(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workflow = self.copy_repository_workflow(root)
            workflows = workflow.parent
            (workflows / "additional.yml").write_text(
                "name: Additional\njobs:\n  other:\n    steps:\n"
                "      - run: echo unexpected\n",
                encoding="utf-8",
            )
            failures = CHECKS.check_ci_workflow(root)
            self.assertTrue(
                any(
                    item.path == Path(".github/workflows/additional.yml")
                    and "unregistered command" in item.message
                    for item in failures
                )
            )

    def test_ci_rejects_an_unregistered_workflow_without_commands(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.copy_repository_workflow(root)
            self.write_additional_workflow(
                root,
                "name: Additional\non: workflow_dispatch\n"
                "permissions:\n  contents: read\njobs: {}\n",
            )
            failures = CHECKS.check_ci_workflow(root)
            self.assertTrue(
                any(
                    item.path == Path(".github/workflows/additional.yml")
                    and "not registered" in item.message
                    for item in failures
                )
            )

    def test_ci_rejects_unpinned_action_in_another_workflow(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.copy_repository_workflow(root)
            self.write_additional_workflow(
                root,
                "name: Additional\non: workflow_dispatch\n"
                "permissions:\n  contents: read\n"
                "jobs:\n  other:\n    steps:\n      - uses: owner/action@main\n",
            )
            failures = CHECKS.check_ci_workflow(root)
            self.assertTrue(
                any(
                    item.path == Path(".github/workflows/additional.yml")
                    and "without a full commit pin" in item.message
                    for item in failures
                )
            )

    def test_ci_rejects_write_permissions_in_another_workflow(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.copy_repository_workflow(root)
            self.write_additional_workflow(
                root,
                "name: Additional\non: workflow_dispatch\n"
                "permissions:\n  contents: write\njobs: {}\n",
            )
            failures = CHECKS.check_ci_workflow(root)
            self.assertTrue(
                any(
                    item.path == Path(".github/workflows/additional.yml")
                    and "only read access" in item.message
                    for item in failures
                )
            )

    def test_ci_rejects_pull_request_target_in_another_workflow(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.copy_repository_workflow(root)
            self.write_additional_workflow(
                root,
                "name: Additional\non: pull_request_target\n"
                "permissions:\n  contents: read\njobs: {}\n",
            )
            failures = CHECKS.check_ci_workflow(root)
            self.assertTrue(
                any(
                    item.path == Path(".github/workflows/additional.yml")
                    and "must not use the pull_request_target" in item.message
                    for item in failures
                )
            )

    def test_ci_rejects_duplicate_registered_run_command(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workflow = self.copy_repository_workflow(root)
            command = "python3 scripts/run_tests.py"
            text = workflow.read_text(encoding="utf-8").replace(
                f"      - name: Test the repository validator\n        run: {command}\n",
                f"      - name: Test the repository validator\n        run: {command}\n"
                f"      - name: Duplicate test command\n        run: {command}\n",
            )
            workflow.write_text(text, encoding="utf-8")
            failures = CHECKS.check_ci_workflow(root)
            self.assertTrue(any("more than once" in item.message for item in failures))

    def test_ci_requires_python_format_and_lint(self):
        expected = {
            "python3 -m ruff check scripts tests",
            "python3 -m ruff format --check scripts tests",
        }
        self.assertTrue(expected.issubset(CHECKS.REQUIRED_CI_COMMANDS))

    def test_ci_commands_must_be_documented(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "docs" / "development.md"
            path.parent.mkdir(parents=True)
            source = SCRIPT.parents[1] / "docs" / "development.md"
            text = source.read_text(encoding="utf-8").replace(
                "python3 scripts/run_tests.py", "python3 scripts/other_tests.py"
            )
            path.write_text(text, encoding="utf-8")
            failures = CHECKS.check_ci_command_documentation(root)
            self.assertTrue(
                any("python3 scripts/run_tests.py" in item.message for item in failures)
            )

    def test_ci_commands_hidden_in_comments_are_not_documented(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "docs" / "development.md"
            path.parent.mkdir(parents=True)
            command = "python3 scripts/run_tests.py"
            source = (SCRIPT.parents[1] / "docs" / "development.md").read_text(
                encoding="utf-8"
            )
            lines = [
                f"<!-- {command} -->" if command in line else line
                for line in source.splitlines()
            ]
            path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            failures = CHECKS.check_ci_command_documentation(root)
            self.assertTrue(any(command in item.message for item in failures))

    def test_dependency_action_hidden_in_a_comment_is_not_documented(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            docs = root / "docs" / "dependencies.md"
            docs.parent.mkdir(parents=True)
            source_root = SCRIPT.parents[1]
            source = (source_root / "docs" / "dependencies.md").read_text(
                encoding="utf-8"
            )
            lines = [
                f"<!-- {line} -->" if "`actions/checkout`" in line else line
                for line in source.splitlines()
            ]
            docs.write_text("\n".join(lines) + "\n", encoding="utf-8")
            (root / "requirements-dev.lock").write_text(
                (source_root / "requirements-dev.lock").read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            failures = CHECKS.check_dependency_records(root)
            self.assertTrue(
                any(
                    "visibly record approved action" in item.message
                    for item in failures
                )
            )

    def test_lockfile_dependencies_must_match_the_visible_record(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            docs = root / "docs" / "dependencies.md"
            docs.parent.mkdir(parents=True)
            source_root = SCRIPT.parents[1]
            docs.write_text(
                (source_root / "docs" / "dependencies.md").read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            lockfile = root / "requirements-dev.lock"
            source = (source_root / "requirements-dev.lock").read_text(encoding="utf-8")
            lockfile.write_text(
                source
                + "\nexample-package==1.0.0 \\\n"
                + "    --hash=sha256:"
                + "0" * 64
                + "\n",
                encoding="utf-8",
            )
            failures = CHECKS.check_dependency_records(root)
            self.assertTrue(any("example-package" in item.message for item in failures))

    def test_lockfile_requires_complete_physical_continuations(self):
        malformed_entries = (
            "example==1.0.0\n    --hash=sha256:" + "0" * 64 + "\n",
            "example==1.0.0 \\\n    --hash=sha256:" + "0" * 64 + " \\\n",
        )
        for content in malformed_entries:
            with (
                self.subTest(content=content),
                tempfile.TemporaryDirectory() as directory,
            ):
                lockfile = Path(directory) / "requirements-dev.lock"
                lockfile.write_text(content, encoding="utf-8")
                _, failures = CHECKS.parse_locked_requirements(lockfile)
                self.assertTrue(failures)


if __name__ == "__main__":
    unittest.main()
