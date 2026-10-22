# Data

Persistent h6ai data: users, roles and folder permissions (`auth.json`) and the server
secret used to sign thumbnail names (`secret.key`).

Make this directory writable for the web server (PHP-FPM user) to manage users in the
admin UI. Back it up. Unlike the cache directories, **don't delete its content**.
