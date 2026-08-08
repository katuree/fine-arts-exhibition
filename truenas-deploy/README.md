# TrueNAS deploy for Fine Arts Exhibition

Use this folder when deploying Syncthing on TrueNAS so artwork files
land in `/mnt/tank/data/fine-arts-exhibition/`.

## Steps

1. Confirm the dataset exists at `/mnt/tank/data/fine-arts-exhibition/`.
2. In TrueNAS, open Apps -> Discover -> Custom App.
3. Choose "Use Docker Compose" and paste `docker-compose.yml` here.
4. Click Install.
5. After the Syncthing Web UI starts on `http://192.168.1.45:8384`,
   open it and add the Windows PC as a remote device.
6. Share the `files/` folder inside Syncthing with the Windows PC
   so artwork uploads that arrive in
   `/mnt/tank/data/fine-arts-exhibition/files/`
   sync to your PC automatically.

The registration API server (`server/`) is a separate component
and should be deployed using the same Custom App flow with its
own docker-compose file.
