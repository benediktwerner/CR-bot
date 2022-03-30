## Requirements

- Node (v14+ should work)
- Python 3.6+

## Setup

1. Install Node dependencies: `npm install`
2. *Optional:* Create a virtual env: `python3 -m venv cr_env` and activate it `source cr_env/bin/activate`
3. Install Python dependencies: `pip install -r requirements.txt`
4. Create a zulip bot, download the `zuliprc` file, and but it in the base directory.
5. Copy `config.base.json` to `config.json` and adjust config values as needed.
    - Set `zulip.stream` to the stream where the bot should respond to queries.
    - If you didn't create a venv or named it differently, set `python_bin` to the Python binary to run CR with (`python3` to use the system Python, `path/to/venv/bin/Python` for a venv)
    - Set `engine.path` to the path where the Stockfish binary is located

## Run

- `npm run dev` for dev. Will watch for changes and restart.
- `npm run build` to build prod dist
- `npm start` to run (after build)
- Or use `CR-bot.service` with systemd
