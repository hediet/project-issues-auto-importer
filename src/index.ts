import { Octokit } from "@octokit/core";

const authToken = readEnvVar("GITHUB_AUTH_TOKEN", "Create a new token with write access to projects");
const gistId = readEnvVar("GIST_ID", "Create an arbitrary new gist and use the id from the url.");
const projectOrg = readEnvVar("PROJECT_ORG", "The github org name of the organization that owns this project.");
const projectName = readEnvVar("PROJECT_NAME", "The name of the project to sync issues to. Should not contain spaces!");
const issueAssignee = readEnvVar("ISSUES_ASSIGNEE", "The github username of the assignee to sync issues for.");
const issueOrg = readEnvVar("ISSUES_ORG", "The organization to read issues from.");
const issueProject = readEnvVar("ISSUES_PROJECT", "The project to read issues from.");

function readEnvVar(envKey: string, help: string): string {
	const value = process.env[envKey];
	if (!value) {
		throw new Error(`The environment variable "${envKey}" must be set! ${help}`);
	}
	return value;
}

const octokit = new Octokit({ auth: authToken });

interface IIssue {
	id: string;
	updatedAt: DateString;
	title: string;
}

type DateString = string;

async function getRecentOpenIssues(since: DateString | undefined): Promise<IIssue[]> {
	const result = await octokit.graphql<{
		repository: { issues: { nodes: { id: string; title: string; updatedAt: string }[] } };
	}>(
		`
		query ($since: DateTime) {
			repository(owner: "${issueOrg}", name: "${issueProject}"){
				issues(first: 100, filterBy: { since: $since, assignee: "${issueAssignee}", states: [OPEN] }, orderBy: { field: UPDATED_AT, direction: ASC }) {
					nodes {
						id,
						title,
						updatedAt
					}
				}
			}
		}
		`,
		{
			since,
		}
	);

	return result.repository.issues.nodes;
}

interface IProject {
	id: string;
	title: string;
	number: number;
}

async function findProject(org: string, query: string): Promise<IProject | undefined> {
	const result = await octokit.graphql<{
		organization: { projectsV2: { nodes: { id: string; title: string; number: number }[] } };
	}>(
		`
			query ($org: String!, $q: String!)  {
				organization(login: $org) {
					projectsV2(first: 10, query: $q) {
						nodes {
							id,
							title,
							number
						}
					}
				}
			}
		`,
		{
			org,
			q: query,
		}
	);

	return result.organization.projectsV2.nodes[0];
}

class StateStore<T> {
	private readonly gistId = gistId;

	async getState(defaultValue: T): Promise<T> {
		const result = await octokit.request("GET /gists/{gist_id}", {
			gist_id: this.gistId,
		});

		const fileContent = result.data.files ? result.data.files["add-issues-to-project.json"] : undefined;

		if (!fileContent) {
			return defaultValue;
		}

		return JSON.parse(fileContent.content!);
	}

	async setState(state: T): Promise<void> {
		await octokit.request(`PATCH /gists/{gist_id}`, {
			gist_id: this.gistId,
			description: "Project Synchronization State",
			files: {
				"add-issues-to-project.json": {
					content: JSON.stringify(state),
				},
			},
		});
	}
}

async function addIssueToProject(project: IProject, issue: IIssue): Promise<void> {
	console.log(`(Re-) Adding "${issue.title}"`);
	const result = await octokit.graphql(
		`
		mutation ($projectId: ID!, $issueContentId: ID!) {
			addProjectV2ItemById(input: {projectId: $projectId, contentId: $issueContentId}) {
			item {
				id
			}
		}
		}
	`,
		{
			projectId: project.id,
			issueContentId: issue.id,
		}
	);
}

async function main() {
	const store = new StateStore<{ version: "1"; lastSyncedSince: string | undefined }>();

	const project = await findProject(projectOrg, projectName);

	if (!project) {
		throw new Error(`Could not find project with name "${projectName}" in org "${projectOrg}"`);
	}

	console.log(`Found project "${project.title}".`);

	const state = await store.getState({ version: "1", lastSyncedSince: undefined });
	let syncedSince = state.lastSyncedSince;

	while (true) {
		const issues = await getRecentOpenIssues(syncedSince);

		if (issues.length === 0 || syncedSince === issues[issues.length - 1].updatedAt) {
			break;
		}

		syncedSince = issues[issues.length - 1].updatedAt;

		for (const issue of issues) {
			await addIssueToProject(project, issue);
		}
	}

	await store.setState({ version: "1", lastSyncedSince: syncedSince });

	console.log("Done!");
}

main();
