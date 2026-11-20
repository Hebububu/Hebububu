import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';

const pageSize = 25;
const excludedLanguages = ['Java', 'JavaScript'];
const repositoryAffiliations = 'OWNER, COLLABORATOR, ORGANIZATION_MEMBER';
const languageFields = `
  totalCount
  totalSize
  pageInfo { hasNextPage endCursor }
  edges { size node { name color } }
`;
const repositoryQuery = `
  query($login: String!, $cursor: String) {
    viewer { login }
    user(login: $login) {
      repositories(
        first: ${pageSize}
        after: $cursor
        isFork: false
        ownerAffiliations: [${repositoryAffiliations}]
        affiliations: [${repositoryAffiliations}]
        orderBy: { field: NAME, direction: ASC }
      ) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          languages(first: ${pageSize}) { ${languageFields} }
        }
      }
    }
  }
`;
const languageQuery = `
  query($id: ID!, $cursor: String!) {
    node(id: $id) {
      ... on Repository {
        languages(first: ${pageSize}, after: $cursor) { ${languageFields} }
      }
    }
  }
`;

async function graphql(query, variables, label) {
  const delays = [0, 5_000, 15_000];
  let reason;
  for (const [index, delay] of delays.entries()) {
    if (delay) await wait(delay);
    const result = spawnSync('gh', ['api', 'graphql', '--hostname', 'github.com', '--input', '-'], {
      input: JSON.stringify({ query, variables }),
      encoding: 'utf8',
      timeout: 25_000,
    });
    const httpStatus = result.stderr?.match(/\bHTTP (\d{3})\b/)?.[1];
    reason = result.error?.code ?? (httpStatus ? `HTTP ${httpStatus}` : 'GraphQL error');
    if (result.status === 0) {
      try {
        const response = JSON.parse(result.stdout);
        if (response.data && !response.errors?.length) return response.data;
      } catch {
        reason = 'invalid JSON response';
      }
    }
    console.warn(`${label} attempt ${index + 1} failed (${reason}).`);
  }
  throw new Error(`${label} failed after ${delays.length} attempts (${reason}).`);
}

function nextCursor(pageInfo, previous) {
  if (!pageInfo.hasNextPage) return null;
  if (!pageInfo.endCursor || pageInfo.endCursor === previous) {
    throw new Error('GitHub pagination did not advance.');
  }
  return pageInfo.endCursor;
}

async function readRepositoryLanguages({ id, languages }) {
  const edges = [...languages.edges];
  let cursor = nextCursor(languages.pageInfo, null);
  while (cursor) {
    const { node } = await graphql(languageQuery, { id, cursor }, 'Language page');
    if (!node?.languages) throw new Error('A repository became unavailable during language collection.');
    edges.push(...node.languages.edges);
    cursor = nextCursor(node.languages.pageInfo, cursor);
  }
  const size = edges.reduce((sum, edge) => sum + edge.size, 0);
  const uniqueLanguages = new Set(edges.map(edge => edge.node.name));
  if (edges.length !== languages.totalCount || uniqueLanguages.size !== edges.length || size !== languages.totalSize) {
    throw new Error('A repository returned incomplete or inconsistent language data.');
  }
  return edges;
}

async function collectLanguageStats(login) {
  const totals = new Map();
  const visitedRepositories = new Set();
  let expectedRepositories;
  let cursor = null;
  do {
    const { viewer, user } = await graphql(repositoryQuery, { login, cursor }, 'Repository page');
    if (viewer.login.toLowerCase() !== login.toLowerCase()) {
      throw new Error('The GitHub credential must belong to the account being ranked.');
    }
    const { repositories } = user;
    expectedRepositories ??= repositories.totalCount;
    if (repositories.totalCount !== expectedRepositories) {
      throw new Error('The repository count changed during collection.');
    }
    for (const repository of repositories.nodes) {
      if (visitedRepositories.has(repository.id)) throw new Error('GitHub returned a duplicate repository.');
      visitedRepositories.add(repository.id);
      for (const { size, node: { name, color } } of await readRepositoryLanguages(repository)) {
        if (excludedLanguages.includes(name) || size === 0) continue;
        const entry = totals.get(name) ?? { name, size: 0, color: null };
        entry.size += size;
        entry.color ??= color;
        totals.set(name, entry);
      }
    }
    cursor = nextCursor(repositories.pageInfo, cursor);
  } while (cursor);

  if (visitedRepositories.size !== expectedRepositories || !totals.size) {
    throw new Error('The ranking requires the full repository list and at least one language.');
  }
  const ranking = [...totals.values()].sort((a, b) => b.size - a.size || a.name.localeCompare(b.name, 'en'));
  return { ranking, repositoryCount: visitedRepositories.size };
}

function escapeMarkup(value) {
  return value.replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
}

function percentage(size, total) {
  const share = 100 * size / total;
  return share < 0.01 ? '<0.01%' : `${share.toFixed(2)}%`;
}

function renderRanking(ranking, total) {
  const lines = ranking.map(({ name, size }, index) =>
    `| ${index + 1} | ${escapeMarkup(name).replaceAll('|', '&#124;')} | ${escapeMarkup(percentage(size, total))} |`);
  return [
    '# Full language ranking',
    '',
    `Ranked by GitHub’s reported code bytes across eligible repositories. ${excludedLanguages.join(' and ')} are excluded.`,
    '',
    '| Rank | Language | Share |',
    '| ---: | --- | ---: |',
    ...lines,
    '',
  ].join('\n');
}

function renderLanguageSection(ranking, total, width) {
  const entries = ranking.slice(0, 8);
  const remaining = ranking.slice(entries.length);
  if (remaining.length) {
    entries.push({ name: 'Other', size: remaining.reduce((sum, entry) => sum + entry.size, 0), color: '#8c959f' });
  }
  const padding = 13;
  const barWidth = width - padding * 2;
  const columnWidth = barWidth / 2;
  const height = 50 + 20 * Math.ceil(entries.length / 2);
  let offset = 0;
  const segments = [];
  const labels = [];
  for (const [index, entry] of entries.entries()) {
    const segmentWidth = barWidth * entry.size / total;
    const color = /^#[0-9a-f]{6}$/i.test(entry.color) ? entry.color : '#64748b';
    const x = padding + (index % 2) * columnWidth;
    const y = 60 + Math.floor(index / 2) * 20;
    segments.push(`<rect x="${(padding + offset).toFixed(3)}" y="34" width="${segmentWidth.toFixed(3)}" height="8" fill="${color}"/>`);
    labels.push(`<circle cx="${x + 5}" cy="${y - 4}" r="4" fill="${color}"/><text x="${x + 16}" y="${y}">${escapeMarkup(entry.name)}</text><text class="language-share" x="${x + columnWidth - 12}" y="${y}" text-anchor="end">${escapeMarkup(percentage(entry.size, total))}</text>`);
    offset += segmentWidth;
  }
  const description = entries.map(entry => `${entry.name} ${percentage(entry.size, total)}`).join(', ');

  const markup = `<section class="profile-languages">
    <svg xmlns="http://www.w3.org/2000/svg" style="display:block" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="profile-language-title profile-language-description">
      <title id="profile-language-title">Most used languages</title>
      <desc id="profile-language-description">${escapeMarkup(description)}</desc>
      <style>
        .profile-languages text { fill: #59636e; font-size: 13px; }
        .profile-languages .language-heading { fill: #0366d6; font-size: 16px; }
        @media (prefers-color-scheme: dark) {
          .profile-languages text { fill: #9ca7b3; }
          .profile-languages .language-heading { fill: #58a6ff; }
        }
      </style>
      <path d="m19 15-5 4 5 4m5-8 5 4-5 4" fill="none" stroke="#959da5" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <text class="language-heading" x="37" y="25">Most used languages</text>
      <clipPath id="profile-language-bar"><rect x="${padding}" y="34" width="${barWidth}" height="8" rx="4"/></clipPath>
      <g clip-path="url(#profile-language-bar)">${segments.join('')}</g>
      <g>${labels.join('')}</g>
    </svg>
  </section>`;
  return { markup, height };
}

function renderOverview(profile, ranking, total) {
  const root = profile.match(/^<svg\b[^>]*>/)?.[0];
  const width = Number(root?.match(/\bwidth="(\d+)"/)?.[1]);
  const baseHeight = Number(root?.match(/\bheight="(\d+)"/)?.[1]);
  const footer = /^[ \t]*<footer>/m;
  if (!width || !baseHeight || !footer.test(profile) || profile.includes('profile-languages')) {
    throw new Error('The Metrics profile SVG has an unexpected layout.');
  }
  const { markup, height } = renderLanguageSection(ranking, total, width);
  return profile
    .replace(root, () => root.replace(`height="${baseHeight}"`, `height="${baseHeight + height}"`))
    .replace(footer, match => `            ${markup}\n${match}`);
}

const [login, profilePath] = process.argv.slice(2);
if (!login || !profilePath) {
  throw new Error('Usage: node .github/scripts/generate-language-stats.mjs <github-login> <metrics-profile-svg>');
}
const profile = await readFile(profilePath, 'utf8');
const { ranking, repositoryCount } = await collectLanguageStats(login);
const total = ranking.reduce((sum, entry) => sum + entry.size, 0);
await Promise.all([
  writeFile('profile-overview.svg', renderOverview(profile, ranking, total)),
  writeFile('languages.md', renderRanking(ranking, total)),
]);
console.log(`Ranked ${ranking.length} languages from ${repositoryCount} eligible repositories. Excluded: ${excludedLanguages.join(', ')}.`);
