ALTER TABLE packages ADD COLUMN repository_owner text;
--> statement-breakpoint
ALTER TABLE packages ADD COLUMN repository_avatar_url text;
--> statement-breakpoint
-- Backfill the same canonical GitHub repository form accepted by repositoryOwner().
-- Only a matching observation for this package can carry its cached avatar forward.
WITH paths AS (
	SELECT registry, name, repository_author_id, substr(repository, length('https://github.com/') + 1) AS path
	FROM packages WHERE repository GLOB 'https://github.com/*'
), parts AS (
	SELECT registry, name, repository_author_id,
		substr(path, 1, instr(path, '/') - 1) AS login,
		substr(path, instr(path, '/') + 1) AS repo
	FROM paths WHERE instr(path, '/') > 0
)
UPDATE packages AS pkg SET repository_owner = parts.login, repository_avatar_url = a.avatar_url
FROM parts LEFT JOIN market_authors AS a ON a.id = parts.repository_author_id
	AND a.kind = 'github' AND lower(a.name) = '@' || lower(parts.login)
WHERE pkg.registry = parts.registry AND pkg.name = parts.name
	AND length(parts.login) BETWEEN 1 AND 39 AND parts.login NOT GLOB '*[^A-Za-z0-9-]*'
	AND parts.login NOT GLOB '-*' AND parts.login NOT GLOB '*-' AND parts.login NOT GLOB '*--*'
	AND length(parts.repo) BETWEEN 1 AND 100 AND parts.repo NOT GLOB '*[^A-Za-z0-9_.-]*'
	AND parts.repo NOT IN ('.', '..');
--> statement-breakpoint
ALTER TABLE packages DROP COLUMN repository_author_id;
--> statement-breakpoint
ALTER TABLE packages DROP COLUMN curated_author_id;
--> statement-breakpoint
DROP TABLE market_authors;
--> statement-breakpoint
CREATE INDEX package_repository_owner ON packages(lower(repository_owner));
