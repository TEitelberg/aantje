# IPython/ipykernel profile config: every kernel starts with `con` (DuckDB + DuckLake)
# and the %sql / %%sql magics. Install as <venv>/etc/ipython/ipython_config.py (or into
# ~/.ipython/profile_default/); see the `oog` package in images/workbench/oog.
c = get_config()  # noqa: F821

c.InteractiveShellApp.extensions.append("oog")
