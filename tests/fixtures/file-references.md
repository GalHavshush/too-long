# File references

## Layout

Code lives in `src/app/config.py`, `src/app/db/models.py` and `src/app/scheduler/{main,reaper}.py`.

## Shortened references

- Edit `config.py` and `db/models.py`.
- `main.py` could be the scheduler or the CLI entry point in `src/app/cli/main.py`.
- `../shared/settings.py` is outside the project and never merged.
- `scheduler/reaper.py` reclaims expired leases.
