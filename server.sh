cd /home/matthias/Github/underground-game
# No --watch: the server only restarts when you restart the service (sudo systemctl restart underground)
exec /home/matthias/.nvm/versions/node/v25.7.0/bin/node src/index.js
