# requires you hold the private key of the pi in question :)

nix build
scp -r ./result/* pi@hugopeters.me:/var/www/blog
