import json


def __load_config():
    with open("config.base.json") as f:
        config = json.load(f)

    try:
        with open("config.json") as f:
            config.update(json.load(f))
    except Exception:
        pass

    return config


config = __load_config()
