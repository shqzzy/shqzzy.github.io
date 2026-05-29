import os
import sys
import click
import json
import subprocess
import functools
import socketserver
import http.server
from datetime import datetime
from pathlib import Path
from subprocess import Popen
import shutil

from src.state import State, Post
import src.generate as generate

state_path = Path("state.json")


@click.group(name="blog")
def cli() -> None:
    """Build management script for static blog site"""


@cli.group(name="post")
def post() -> None:
    """Post module for management script"""


@cli.command(name="init")
@click.option("--force", is_flag=True, default=False)
def init_cmd(force: bool) -> None:
    if state_path.exists() and not force:
        click.echo("state.json already exists, blog already initialized")
        sys.exit(1)

    state = State([Post(0, "test_post", datetime.now(), ["secret_language"])])
    state_path.write_text(json.dumps(state.to_json()))


@cli.command(name="build")
@click.option("--debug", is_flag=True, default=False)
def build_cmd(debug: bool) -> None:
    state = getState()
    output_dir = Path("ignore") / "build"
    source_dir = Path("design")
    generate.build(source_dir, state, output_dir, debug=debug)


@post.command(name="list")
def post_list_cmd() -> None:
    state = getState()
    for post in state.posts:
        print(f"{post.number}. {post.title}")


@post.command(name="create")
def post_create_cmd() -> None:
    state = getState()
    new_id = 1 + max([x.number for x in state.posts])
    title = click.prompt("Title")
    abstract = click.prompt("Abstract", default="No abstract available")
    languages = click.prompt("Languages").split(",")

    template_file = Path("design") / "templates" / "post_empty.html"

    result_dir = Path("design") / "posts" / str(new_id)
    result_dir.mkdir(exist_ok=True)

    shutil.copyfile(template_file, result_dir / "index.html")

    # Create empty abstract
    with open(result_dir / "abstract.html", "w") as f:
        f.write(abstract)

    post = Post(new_id, title, datetime.now(), languages, "favicon")
    state.posts.append(post)
    saveState(state)
    #os.system("%s %s" % (os.getenv("EDITOR"), result_dir / "index.html"))
    file_path = Path("design") / "posts" / str(number) / "index.html"
    editor_path = os.getenv("EDITOR")
    editorcommand = f'"{editor_path}"'  # Wraps the path in quotes
    #print(editorcommand)
    os.system("%s %s" % (editorcommand, file_path))


@post.command(name="edit")
@click.option("--number", default=-1)
def post_edit_cmd(number: int) -> None:
    state = getState()
    # Resolve last post if not given
    if number == -1:
        number = max([x.number for x in state.posts])

    file_path = Path("design") / "posts" / str(number) / "index.html"
    editor_path = os.getenv("EDITOR")
    editorcommand = f'"{editor_path}"'  # Wraps the path in quotes
    #print(editorcommand)
    os.system("%s %s" % (editorcommand, file_path))


@post.command(name="delete")
@click.option("--number", default=-1)
def post_delete_cmd(number: int) -> None:
    state = getState()
    # Resolve last post if not given
    if number == -1:
        number = max([x.number for x in state.posts])

    if number not in [x.number for x in state.posts]:
        click.echo(f"Post {number} does not exist")
        sys.exit(1)

    post = next(x for x in state.posts if x.number == number)

    click.echo(f"You are about to delete post {number}: {post.title}")
    click.confirm("Are you sure?", abort=True)
    state.posts = list([x for x in state.posts if x.number != number])
    saveState(state)


@cli.command("preview")
@click.option("--port", default=8000, type=int, help="Port to use")
@click.option("--bind", default="", help="Address to bind on (default: all interfaces)")
@click.option(
    "--watch", is_flag=True, default=False, help="Auto rebuild on source changes"
)
def preview_cmd(port: int, bind: str, watch: bool) -> None:
    """Run a local webserver on build output"""
    output_dir = Path("ignore/build")
    if not output_dir.is_dir():
        click.echo("No output to serve. Please run `blog build` first.", err=True)
        sys.exit(1)

    click.launch(f"http://localhost:{port}")

    if watch:
        Popen(["scripts/watch.sh"])

    # Start the default Python HTTP server.
    #
    # We want to specify that the `build` directory is used for serving
    # the responses. The TCPServer class expects a `handler_class` to
    # initialize, so we can't construct in a `SimpleHTTPRequestHandler`
    # instance and pass it the `directory` argument directly. Instead
    # we need to partially apply the constructor with the `directory`
    # keyword argument and pass that as the handler_class.
    #
    # This feels more complicated than it should be.
    server_address = (bind, port)
    socketserver.TCPServer.allow_reuse_address = True
    handler_class = functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=str(output_dir)
    )

    print("starting server")
    with socketserver.TCPServer(server_address, handler_class) as httpd:  # type: ignore
        click.echo(f"Serving {output_dir} at port {port}", err=True)
        httpd.serve_forever()


def getState() -> State:
    if not state_path.exists():
        click.echo("Could not find state.json, please run blog init first")
        sys.exit(1)

    state = State.from_json(json.loads(state_path.read_text()))
    if not state:
        click.echo("state.json is not valid")
        sys.exit(1)
    return state


def saveState(state: State) -> None:
    with open(state_path, "w") as f:
        json.dump(state.to_json(), f, indent=4)


def main() -> None:
    cli()
