cd /home/matthias/Github/underground-game
# --watch restarts the server whenever a file in src/ or public/ changes
exec /home/matthias/.nvm/versions/node/v25.7.0/bin/node --watch-path=src --watch-path=public src/index.js
