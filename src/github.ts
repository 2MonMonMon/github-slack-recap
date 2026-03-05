import { Octokit } from "@octokit/rest";

export interface PullRequest {
  id: number;
  title: string;
  url: string;
  repo: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  baseBranch: string;
  reviewDecision: string | null;
  approvalCount: number;
  unresolvedThreadCount: number;
  overdueReviewers: string[]; // requested 24h+ ago, still haven't responded
  ciStatus: "success" | "failure" | "pending" | "unknown";
  recentComments: Comment[];
  recentReviews: Review[];
  requestedReviewers: string[];
}

export interface ReviewRequest {
  id: number;
  title: string;
  url: string;
  repo: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  author: string;
  body: string;
  url: string;
  createdAt: string;
}

export interface Review {
  author: string;
  state: string;
  url: string;
  submittedAt: string;
}

export interface GitHubData {
  myOpenPRs: PullRequest[];
  reviewRequests: ReviewRequest[];
}

const SINCE_HOURS = 24;

function since(): string {
  const d = new Date();
  d.setHours(d.getHours() - SINCE_HOURS);
  return d.toISOString();
}

async function getCiStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string
): Promise<PullRequest["ciStatus"]> {
  try {
    const { data } = await octokit.repos.getCombinedStatusForRef({ owner, repo, ref });
    if (data.state === "success") return "success";
    if (data.state === "failure" || data.state === "error") return "failure";
    return "pending";
  } catch {
    return "unknown";
  }
}

interface GraphQLPRData {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: { isResolved: boolean }[];
        };
        timelineItems: {
          nodes: Array<{
            createdAt?: string;
            requestedReviewer?: { login?: string };
          }>;
        };
      };
    };
  };
}

async function getGraphQLDetails(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<{ unresolvedThreadCount: number; reviewRequestedAt: Map<string, string> }> {
  try {
    const result = await octokit.request("POST /graphql", {
      query: `
        query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100) {
                nodes { isResolved }
              }
              timelineItems(first: 100, itemTypes: [REVIEW_REQUESTED_EVENT]) {
                nodes {
                  ... on ReviewRequestedEvent {
                    createdAt
                    requestedReviewer {
                      ... on User { login }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      variables: { owner, repo, number: pullNumber },
    }) as GraphQLPRData;

    const pr = result.data.repository.pullRequest;

    const unresolvedThreadCount = pr.reviewThreads.nodes.filter((t) => !t.isResolved).length;

    // Track the latest time each reviewer was requested
    const reviewRequestedAt = new Map<string, string>();
    for (const node of pr.timelineItems.nodes) {
      const login = node.requestedReviewer?.login;
      const createdAt = node.createdAt;
      if (login && createdAt) {
        const existing = reviewRequestedAt.get(login);
        if (!existing || createdAt > existing) {
          reviewRequestedAt.set(login, createdAt);
        }
      }
    }

    return { unresolvedThreadCount, reviewRequestedAt };
  } catch {
    return { unresolvedThreadCount: 0, reviewRequestedAt: new Map() };
  }
}

async function getPRDetails(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  sinceDate: string
): Promise<{
  comments: Comment[];
  reviews: Review[];
  ciStatus: PullRequest["ciStatus"];
  headSha: string;
  additions: number;
  deletions: number;
  requestedReviewers: string[];
  reviewDecision: string | null;
  approvalCount: number;
  baseBranch: string;
  unresolvedThreadCount: number;
  overdueReviewers: string[];
}> {
  const [prData, commentsData, reviewsData, graphql] = await Promise.all([
    octokit.pulls.get({ owner, repo, pull_number: pullNumber }),
    octokit.issues.listComments({ owner, repo, issue_number: pullNumber, since: sinceDate }),
    octokit.pulls.listReviews({ owner, repo, pull_number: pullNumber }),
    getGraphQLDetails(octokit, owner, repo, pullNumber),
  ]);

  const headSha = prData.data.head.sha;
  const ciStatus = await getCiStatus(octokit, owner, repo, headSha);

  const comments: Comment[] = commentsData.data.map((c) => ({
    author: c.user?.login ?? "unknown",
    body: c.body?.slice(0, 120) ?? "",
    url: c.html_url,
    createdAt: c.created_at,
  }));

  const recentReviews: Review[] = reviewsData.data
    .filter((r) => r.submitted_at && r.submitted_at >= sinceDate)
    .map((r) => ({
      author: r.user?.login ?? "unknown",
      state: r.state,
      url: r.html_url ?? "",
      submittedAt: r.submitted_at ?? "",
    }));

  const requestedReviewers = prData.data.requested_reviewers?.map((r) => r.login) ?? [];

  // Latest review state per reviewer → approval count + overall decision
  const reviews = reviewsData.data;
  const latestPerReviewer = new Map<string, string>();
  for (const r of reviews) {
    if (r.user?.login && r.state !== "COMMENTED") {
      latestPerReviewer.set(r.user.login, r.state);
    }
  }
  const latestStates = [...latestPerReviewer.values()];
  const approvalCount = latestStates.filter((s) => s === "APPROVED").length;

  let reviewDecision: string | null = null;
  if (latestStates.some((s) => s === "CHANGES_REQUESTED")) reviewDecision = "CHANGES_REQUESTED";
  else if (approvalCount > 0) reviewDecision = "APPROVED";

  // Overdue reviewers: still in requestedReviewers AND last requested 24h+ ago
  const cutoff = sinceDate; // reuse the 24h cutoff
  const overdueReviewers = requestedReviewers.filter((login) => {
    const requestedAt = graphql.reviewRequestedAt.get(login);
    return requestedAt !== undefined && requestedAt < cutoff;
  });

  return {
    comments,
    reviews: recentReviews,
    ciStatus,
    headSha,
    additions: prData.data.additions,
    deletions: prData.data.deletions,
    requestedReviewers,
    reviewDecision,
    approvalCount,
    baseBranch: prData.data.base.ref,
    unresolvedThreadCount: graphql.unresolvedThreadCount,
    overdueReviewers,
  };
}

export async function fetchGitHubData(token: string, username: string): Promise<GitHubData> {
  const octokit = new Octokit({ auth: token });
  const sinceDate = since();

  // Fetch open PRs authored by user
  const { data: myPRsSearch } = await octokit.search.issuesAndPullRequests({
    q: `is:pr is:open draft:false author:${username}`,
    sort: "updated",
    order: "desc",
    per_page: 20,
  });

  // Fetch PRs where review is requested from user
  const { data: reviewRequestsSearch } = await octokit.search.issuesAndPullRequests({
    q: `is:pr is:open draft:false review-requested:${username}`,
    sort: "updated",
    order: "desc",
    per_page: 20,
  });

  // Enrich open PRs with details
  const myOpenPRs = await Promise.all(
    myPRsSearch.items.map(async (pr): Promise<PullRequest> => {
      const [owner, repo] = (pr.repository_url ?? "").split("/").slice(-2);
      const pullNumber = pr.number;

      const details = await getPRDetails(octokit, owner, repo, pullNumber, sinceDate);

      return {
        id: pr.id,
        title: pr.title,
        url: pr.html_url,
        repo: `${owner}/${repo}`,
        draft: pr.draft ?? false,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        additions: details.additions,
        deletions: details.deletions,
        baseBranch: details.baseBranch,
        reviewDecision: details.reviewDecision,
        approvalCount: details.approvalCount,
        unresolvedThreadCount: details.unresolvedThreadCount,
        overdueReviewers: details.overdueReviewers,
        ciStatus: details.ciStatus,
        recentComments: details.comments,
        recentReviews: details.reviews,
        requestedReviewers: details.requestedReviewers,
      };
    })
  );

  const reviewRequests: ReviewRequest[] = reviewRequestsSearch.items.map((pr) => {
    const [owner, repo] = (pr.repository_url ?? "").split("/").slice(-2);
    return {
      id: pr.id,
      title: pr.title,
      url: pr.html_url,
      repo: `${owner}/${repo}`,
      author: pr.user?.login ?? "unknown",
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
    };
  });

  return { myOpenPRs, reviewRequests };
}
