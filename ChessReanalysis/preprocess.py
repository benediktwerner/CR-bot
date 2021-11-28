import sys
from multiprocessing import Manager, Pool

import chess
import chess.engine
import chess.pgn

from config import config
from models import *

sys.setrecursionlimit(10000)


def run(working_set):
    # Exclude already-processed games
    to_process = set(working_set.keys()) - {
        g.id for g in Game.select(Game.id).where(Game.is_analyzed == True)
    }
    print(f"Skipping {len(working_set) - len(to_process)} already-processed games")

    parallelism = config["engine"].get("parallelism", 1)
    print("Starting pool")

    manager = Manager()
    lock = manager.Lock()
    total_moves = 0
    for gid in to_process:
        total_moves += len(list(working_set[gid].mainline_moves()))
    pool = Pool(parallelism)
    process_args = [
        {"db_lock": lock, "total": len(to_process), "pgn": working_set[gid], "gid": gid}
        for gid in to_process
    ]

    print(f"Processing {parallelism} / {len(to_process)} games at a time")
    pool.map_async(process_game, process_args)
    pool.close()
    pool.join()


def process_game(args):
    db_lock = args["db_lock"]
    gid = args["gid"]
    pgn = args["pgn"]
    moves = list(pgn.mainline_moves())

    # Get the game DB object and the PGN moves
    with db_lock:
        game_obj, _ = Game.get_or_create(id=gid)

        white, _ = Player.get_or_create(username=pgn.headers["White"].lower())
        black, _ = Player.get_or_create(username=pgn.headers["Black"].lower())
        GamePlayer.get_or_create(game=game_obj, color="w", defaults={"player": white})
        GamePlayer.get_or_create(game=game_obj, color="b", defaults={"player": black})

    # Set up the engine
    engine = chess.engine.SimpleEngine.popen_uci(config["engine"]["path"])

    # Set up the board
    board = pgn.board()
    for m in moves:
        board.push(m)

    # Process each move in the game in reverse order
    moves_processed = 0
    for played_move in reversed(moves):
        board.pop()
        moves_processed += 1
        color = "w" if board.turn == chess.WHITE else "b"
        # Skip already-processed moves
        try:
            with db_lock:
                move = Move.get(
                    game=game_obj, color=color, number=board.fullmove_number
                )
            continue
        except DoesNotExist:
            pass

        while True:
            try:
                # Run the engine for the top 5 moves
                info = engine.analyse(
                    board,
                    chess.engine.Limit(nodes=config["engine"]["nodes"]),
                    multipv=5,
                    options=config["engine"]["options"],
                )
                # Get the engine results
                pvs = {i + 1: info["pv"][0] for (i, info) in enumerate(info)}
                evals = {
                    i + 1: score_to_cp(info["score"]) for (i, info) in enumerate(info)
                }
                played_index = None
                for i, move in pvs.items():
                    if move == played_move:
                        played_index = i
                if not played_index:
                    # The played move was not in the top 5, so we need to analyze it separately
                    board.push(played_move)
                    if board.is_checkmate():
                        played_eval = 29999 if board.turn == chess.BLACK else -29999
                    else:
                        one_move_info = engine.analyse(
                            board,
                            chess.engine.Limit(nodes=config["engine"]["nodes"]),
                            multipv=1,
                            options=config["engine"]["options"],
                        )
                        played_eval = -score_to_cp(one_move_info[0]["score"])
                    board.pop()
                else:
                    # The played move was in the top 5, so we can copy the corresponding eval to save time
                    played_eval = evals[played_index]

                # Store the evaluations in the DB
                with db_lock:
                    move = Move.create(
                        game=game_obj,
                        color=color,
                        number=board.fullmove_number,
                        pv1_eval=evals.get(1),
                        pv2_eval=evals.get(2),
                        pv3_eval=evals.get(3),
                        pv4_eval=evals.get(4),
                        pv5_eval=evals.get(5),
                        played_rank=played_index,
                        played_eval=played_eval,
                        nodes=info[0].get("nodes"),
                        masterdb_matches=masterdb_matches(board, move),
                    )
                break
            except TypeError:
                # If we get a bad engine output, score_to_cp will throw a TypeError. We can just retry
                continue

    with db_lock:
        game_obj.is_analyzed = True
        game_obj.save()

    engine.quit()


def masterdb_matches(board, move):
    pass


def score_to_cp(score):
    # Some arbitrary extreme values have been picked to represent mate
    if score.is_mate():
        return (
            30000 - score.relative.mate()
            if score.relative.mate() > 0
            else -30000 - score.relative.mate()
        )
    return min(max(score.relative.score(), -29000), 29000)
