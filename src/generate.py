import jinja2
import shutil
import click
import os
import re
import subprocess
import xml.etree.ElementTree as ET
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from pathlib import Path
from datetime import datetime, timezone
from email.utils import format_datetime
from typing import Callable, List, Any, Optional, Tuple
from pygments.formatters import HtmlFormatter  # type: ignore
import pygments.lexers  # type: ignore
from PIL import Image  # type: ignore

from src.state import State, Post, PreparedPost, PreparedState

def include_file(filename: str):
    with open(filename, "r") as f:
        return f.readlines()


def build(
    source_dir: Path, locked_state: State, output_dir: Path, debug: bool = False
) -> None:

    if debug:
        print("DEBUG ENABLED!")

    clear_directory(output_dir)
    output_dir.mkdir(exist_ok=True, parents=True)

    # Copy public files from design
    for entry in source_dir.iterdir():
        if entry.is_dir():
            if entry.name == "templates":
                continue
            shutil.copytree(entry, output_dir / entry.name)
        else:
            shutil.copy(entry, output_dir)

    # Optimize assets in the build output
    optimize_images(output_dir)
    optimize_gifs(output_dir)

    # Prepare state
    state = prepareState(locked_state, output_dir)

    # Setup jinja2 context
    env = jinja2.Environment(loader=jinja2.FileSystemLoader("design/"))
    env.globals["DEBUG"] = debug
    env.globals["highlight"] = highlight
    env.globals["refPostString"] = lambda post_id: refPostString(state, post_id)
    env.globals["include_file"] = include_file

    load_template: Callable[
        [Path], jinja2.Template
    ] = lambda template_file: env.get_template(str(template_file).replace('\\', '/'))

    # Render index
    template = load_template(Path("index.html"))
    with open(output_dir / "index.html", "w") as f:
        template.stream(state=state).dump(f)

    # Render posts index
    posts_dir = output_dir / "posts"
    template = load_template(Path("posts") / "index.html")
    with open(posts_dir / "index.html", "w") as f:
        template.stream(state=state).dump(f)

    for post in state.posts:
        post_path = posts_dir / str(post.number)

        # load template
        template = load_template(Path("posts") / str(post.number) / "index.html")
        render = template.render(post=post)

        # overwrite template with rendered version
        with open(post_path / "index.html", "w", encoding="utf-8") as f:
            f.write(render)

    # Generate RSS feed
    generate_rss(state, output_dir)


def prepareState(state: State, root: Path) -> PreparedState:
    posts_dir = root / "posts"
    prepared_posts = []
    for post in state.posts:
        post_path = posts_dir / str(post.number)

        modifiedAt = lastModified(post_path)

        # load the abstract
        abstract = "abstract not available"
        abstract_path = post_path / "abstract.html"
        if abstract_path.exists():
            with open(abstract_path, "r") as f:
                abstract = f.read()
        prepared_posts.append(
            PreparedPost(
                post.number,
                post.title,
                post.postedAt,
                post.languages,
                post.favicon,
                modifiedAt,
                abstract,
            )
        )

    return PreparedState(prepared_posts)


SITE_URL = "https://shqzzy.github.io"


def generate_rss(state: PreparedState, output_dir: Path) -> None:
    """Generate an RSS 2.0 feed from the prepared blog state."""
    rss = ET.Element("rss", version="2.0", attrib={"xmlns:atom": "http://www.w3.org/2005/Atom"})
    channel = ET.SubElement(rss, "channel")

    ET.SubElement(channel, "title").text = "Hugo's Blog"
    ET.SubElement(channel, "link").text = SITE_URL
    ET.SubElement(channel, "description").text = (
        "GPU programming, functional programming, and efficient code."
    )
    ET.SubElement(channel, "language").text = "en"

    feed_url = f"{SITE_URL}/feed.xml"
    atom_link = ET.SubElement(channel, "{http://www.w3.org/2005/Atom}link")
    atom_link.set("href", feed_url)
    atom_link.set("rel", "self")
    atom_link.set("type", "application/rss+xml")

    sorted_posts = sorted(state.posts, key=lambda p: p.postedAt, reverse=True)

    if sorted_posts:
        ET.SubElement(channel, "lastBuildDate").text = format_datetime(
            sorted_posts[0].postedAt.replace(tzinfo=timezone.utc)
        )

    for post in sorted_posts:
        item = ET.SubElement(channel, "item")
        ET.SubElement(item, "title").text = post.title
        post_url = f"{SITE_URL}/posts/{post.number}"
        ET.SubElement(item, "link").text = post_url
        ET.SubElement(item, "guid", isPermaLink="true").text = post_url
        ET.SubElement(item, "pubDate").text = format_datetime(
            post.postedAt.replace(tzinfo=timezone.utc)
        )
        ET.SubElement(item, "description").text = post.abstract

    tree = ET.ElementTree(rss)
    ET.indent(tree, space="  ")
    tree.write(
        output_dir / "feed.xml",
        xml_declaration=True,
        encoding="utf-8",
    )
    click.echo(f"Generated RSS feed with {len(sorted_posts)} items")


def clear_directory(dir_path: Path) -> None:
    """Remove all directory contents, except for the directory itself.

    This is useful so the inode number for the directory doesn't get removed
    and HTTP servers and the like keep on working."""

    if not dir_path.exists():
        return

    assert dir_path.is_dir()

    for entry in dir_path.iterdir():
        if entry.is_dir():
            shutil.rmtree(entry)
        else:
            entry.unlink()


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png"}
MAX_DIMENSION = 1920
JPEG_QUALITY = 80
PNG_MAX_COLORS = 256


def _optimize_single_image(img_path: Path) -> Tuple[int, int]:
    """Optimize a single image file. Returns (saved_bytes, was_optimized)."""
    original_size = img_path.stat().st_size

    try:
        img = Image.open(img_path)
    except Exception:
        return (0, 0)

    if img.width > MAX_DIMENSION or img.height > MAX_DIMENSION:
        img.thumbnail((MAX_DIMENSION, MAX_DIMENSION), Image.LANCZOS)

    suffix = img_path.suffix.lower()
    if suffix in (".jpg", ".jpeg"):
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        img.save(img_path, "JPEG", quality=JPEG_QUALITY, optimize=True)
    elif suffix == ".png":
        if img.mode == "RGBA":
            img = img.quantize(colors=PNG_MAX_COLORS, method=Image.Quantize.FASTOCTREE)
        elif img.mode == "P":
            pass
        else:
            img = img.convert("RGB").quantize(colors=PNG_MAX_COLORS, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
        img.save(img_path, "PNG", optimize=True)

    new_size = img_path.stat().st_size
    saved = original_size - new_size
    if saved > 0:
        return (saved, 1)
    return (0, 0)


def optimize_images(output_dir: Path) -> None:
    """Optimize images in the build directory for the web.

    Resizes images that exceed MAX_DIMENSION, compresses JPEGs with reduced
    quality, and quantizes PNGs to reduce file size. Runs in parallel across
    available CPU cores. The original files in the design directory are never
    modified.
    """
    image_paths = [
        p for p in output_dir.rglob("*")
        if p.suffix.lower() in IMAGE_EXTENSIONS
    ]

    if not image_paths:
        return

    optimized = 0
    saved_bytes = 0

    with ProcessPoolExecutor() as pool:
        for saved, count in pool.map(_optimize_single_image, image_paths):
            saved_bytes += saved
            optimized += count

    if optimized > 0:
        click.echo(f"Optimized {optimized} images, saved {saved_bytes / 1024:.1f} KB")


def _optimize_single_gif(gif_path: Path) -> Tuple[int, int]:
    """Optimize a single GIF file. Returns (saved_bytes, was_optimized)."""
    original_size = gif_path.stat().st_size
    original_bytes = gif_path.read_bytes()
    subprocess.run(
        ["gifsicle", "--optimize=3", "--lossy=80", "--batch", str(gif_path)],
        capture_output=True,
    )
    new_size = gif_path.stat().st_size
    saved = original_size - new_size
    if saved > 0:
        return (saved, 1)
    gif_path.write_bytes(original_bytes)
    return (0, 0)


def optimize_gifs(output_dir: Path) -> None:
    """Optimize GIF files using gifsicle (lossy compression + optimization).

    Runs gifsicle invocations in parallel using threads.
    """
    try:
        subprocess.run(["gifsicle", "--version"], capture_output=True, check=True)
    except (FileNotFoundError, subprocess.CalledProcessError):
        click.echo("gifsicle not found, skipping GIF optimization")
        return

    gif_paths = list(output_dir.rglob("*.gif"))
    if not gif_paths:
        return

    optimized = 0
    saved_bytes = 0

    with ThreadPoolExecutor() as pool:
        for saved, count in pool.map(_optimize_single_gif, gif_paths):
            saved_bytes += saved
            optimized += count

    if optimized > 0:
        click.echo(f"Optimized {optimized} GIFs, saved {saved_bytes / 1024:.1f} KB")


def highlight(lang: str, code: str, source: Optional[str] = None) -> str:
    formatter = HtmlFormatter()

    # special all() function that return false for empty sets
    alln: Callable[[List[Any]], bool] = lambda l: all(l) and len(l) > 0

    # Remove all shared whitespace
    lines = code.split("\n")
    while alln([str(x)[0].isspace() for x in lines if len(x) > 0]):
        for i in range(len(lines)):
            if len(lines[i]) > 0:
                lines[i] = lines[i][1:]
    code = "\n".join(lines)
    lex = pygments.lexers.get_lexer_by_name(lang)
    res = str(pygments.highlight(code, lex, formatter))
    # Assuming tag ends with the 6 characters of '</div>'
    if source:
        res = (
            res[:-7]
            + f'<a class="source" href="{source}" target="_blank">full source</a></pre></div>'
        )
    return res

def lastModified(path: Path) -> datetime:
    latest = 0
    for entry in path.glob("*"):
        if not entry.is_dir():
            mtime = int(entry.stat().st_mtime)
            latest = max(latest, mtime)

    return datetime.fromtimestamp(latest)


def refPostString(state: PreparedState, post_id: int) -> str:
    for post in state.posts:
        if post.number == post_id:
            res_post = post
            break
    else:
        raise Exception(f"Post {post_id} does not exist but is referenced")
    return f'<a href="/posts/{post_id}">{res_post.title}</a>'
