# Cache

Private cache: compiled config, login rate limits, folder sizes, command detection, and on
drop-in installs the links nginx uses to send files.

Make this directory writable for the PHP user. Nothing in here is critical: deleting the content
clears the cache, h6ai recreates what it needs.
