# Oog workspace

This private repository belongs to the local Oog stack. The workbench clones it on first start to
`/home/coder/workspace/<repository name>` and opens the folder in VS Code. Source control shows the changes;
commit and push go straight to this Gitea server.

```
notebooks/local/   the medallion demo on the local DuckLake (DuckDB):
                   01-medallion-generator  creates raw test data (Parquet) for an online shop
                   02-medallion-pipeline   loads Bronze, Silver and Gold, one load date at a time
                   03-medallion-cleanup    undoes it again (dry run by default)
notebooks/quack/   the same three notebooks for the DuckLake that the Quack server serves (catalog oog_quack)
notebooks/azure/   the same three notebooks for an Azure DuckLake; the connection data is in
                   azure.config.json (read through azure_lake.py), see the README of the stack
```

Open a notebook and pick the kernel **Oog**. Endpoints and credentials come from the `OOG_*` environment
variables of the workbench; the kernel provides the DuckDB connection `con` with the DuckLake `oog` attached.
Browse the lake with the aantje extension (activity bar).

## Saving changes

```sh
git add -A
git commit -m "Description"
git push
```

## On your own machine

```sh
git clone http://localhost:3000/<user>/<repository name>.git
```

The credentials are those of the Gitea admin account from the `.env` (`OOG_GITEA_ADMIN_USER` and
`OOG_GITEA_ADMIN_PASSWORD`).

## Restoring the examples

The workbench image contains the examples under `/opt/oog/workspace-seed`:

```sh
cp -R /opt/oog/workspace-seed/notebooks/. ~/workspace/<repository name>/notebooks/
```

The notebooks used to be directly in `notebooks/`. A repository from an earlier version keeps them there: after the
copy remove the old `notebooks/0?-*.ipynb` files (`git rm`) so that only `local/`, `quack/` and `azure/` are left. The notebooks 02 and 03 in `local/` lost the `LAKE` switch:
they work in the DuckLake on PostgreSQL only; use `quack/` for the Quack server.
