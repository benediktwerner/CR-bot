import re
import sys

import chess.pgn

import analyze
import preprocess

GAME_LINK_REGEX = re.compile(
    r"^(https?://)?([a-z]+\.)?lichess\.org/([A-Za-z0-9]{8})([A-Za-z0-9]{4})?([/#\?].*)?$"
)


def gameid(game):
    gamelink = game.headers["Site"]
    if gamelink is None or gamelink == "":
        return None
    match = GAME_LINK_REGEX.match(gamelink)
    if match is None:
        return None
    return match.group(3)


def load_pgn(filename):
    working_set = {}
    with open(filename, encoding="iso-8859-1") as fin:
        n = 0
        while True:
            game = chess.pgn.read_game(fin)
            if not game:
                break
            gid = gameid(game)
            if gid and game.headers.get("Variant") == "Standard":
                working_set[gid] = game
            n += 1
        print(f"Added {n} games to working set from {filename}")
    return working_set


def main(inpath: str, outpath: str):
    working_set = load_pgn(inpath)
    preprocess.run(working_set)
    analyze.a1(working_set, outpath)


if __name__ == "__main__":
    main(*sys.argv[1:])
