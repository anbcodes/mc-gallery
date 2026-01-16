import { createServer } from 'http';
import fs, { cpSync, linkSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { stat, writeFile } from 'fs/promises';
import { join } from 'path';
import mime from 'mime';
import busboy from 'busboy';

const __dirname = new URL('.', import.meta.url).pathname;

const outDir = process.argv[2] ?? join(__dirname, './out');
const hostname = process.argv[3] ?? '0.0.0.0';
const port = +(process.argv[4] ?? 3000);
const dev = process.env.NODE_ENV !== 'production';

const imagesDir = join(outDir, "images");
const deletedImagesDir = join(outDir, "deleted_images");
mkdirSync(imagesDir, { recursive: true });
mkdirSync(deletedImagesDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

readdirSync(join(__dirname, "static")).forEach(file => {
  rmSync(join(outDir, file), { recursive: true, force: true });
  if (dev) {
    symlinkSync(join(__dirname, "static", file), join(outDir, file));
  } else {
    cpSync(join(__dirname, "static", file), join(outDir, file), { recursive: true });
  }
});

const dataFile = join(outDir, "data.json");
let data = {
  version: 1,
  servers: [],
}

try {
  const fileData = fs.readFileSync(dataFile, 'utf-8');
  data = JSON.parse(fileData);
} catch (e) {
  console.log("No existing data file, starting fresh.");
}

let writeTimeout
const save = () => {
  clearTimeout(writeTimeout)
  writeTimeout = setTimeout(() => {
    writeFile(dataFile, JSON.stringify(data, null, 2))
  }, 1000);
}

let templates = {
  index: "",
}
const loadTemplates = () => {
  templates.index = fs.readFileSync(join(__dirname, 'index.html'), 'utf-8');
}
loadTemplates();

const xssEscape = (str) => {
  return str.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

const regenerateStaticFiles = () => {
  if (dev) loadTemplates();

  console.log("REGENERATING", data)

  let form = `
    <form action="/api/save" method="POST" enctype="multipart/form-data">
      <h2>Upload Screenshot</h2>
      <label>
        Server Name:<br/>
        <input type="text" name="server" list="servers" required />
        <datalist id="servers">
          ${data.servers.map(s => `<option value="${xssEscape(s.server)}">`).join('\n')}
        </datalist>
      </label>
      <br/>
      <label>
        Description:<br/>
        <textarea name="description" rows="4" cols="50"></textarea>
      </label>
      <br/>
      <label>
        Screenshot:<br/>
        <input type="file" name="screenshot" accept="image/*" required />
      </label>
      <br/>
      <button type="submit">Upload</button>
    </form>
  `

  let serversHtml = data.servers.map(server => {
    let imagesHtml = server.images.map(image => {
      return `
        <div class="image-entry">
          <img src="/images/${xssEscape(image.filename)}" alt="${xssEscape(image.description)}" />
          <p>${xssEscape(image.description)}</p>
        </div>
      `;
    }).join('\n');

    return `
      <section id="${xssEscape(server.slug)}">
        <h2>${xssEscape(server.server)}</h2>
        <div class="images-container">
          ${imagesHtml}
        </div>
      </section>
    `;
  }).join('\n');

  let serverList = data.servers.map(server => {
    return `<li><a href="#${xssEscape(server.slug)}">${xssEscape(server.server)}</a></li>`;
  }).join('\n');

  let indexHtml = templates.index;
  indexHtml = indexHtml.replaceAll('{{UPLOAD}}', form);
  indexHtml = indexHtml.replaceAll('{{SERVER_LIST}}', serverList);
  indexHtml = indexHtml.replaceAll('{{SERVERS}}', serversHtml);

  console.log(indexHtml, templates.index);

  writeFileSync((join(outDir, 'index.html')), indexHtml);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:3823`);
  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    let filePath = join(outDir, url.pathname.slice(1));
    try {
      if ((await stat(filePath)).isDirectory()) {
        filePath = join(filePath, 'index.html');
      }
    } catch (_) {
      // File doesn't exist
      filePath = filePath + '.html';
    }

    let stream = fs.createReadStream(filePath);
    stream.on('error', (_) => {
      res.statusCode = 404;
      res.end('404 Not Found');
    });
    res.statusCode = 200;
    res.setHeader('Content-Type', mime.getType(filePath) || 'application/octet-stream');
    stream.pipe(res);
  } else if (req.method === "POST" && url.pathname === "/api/save") {
    let bb = busboy({ headers: req.headers });
    let info = {
      description: "",
      server: "",
      filename: "",
    }
    bb.on("field", (name, val) => {
      if (name in info) {
        info[name] = val;
      }
    });
    bb.on('file', (name, file, meta) => {
      const filename = new Date().toISOString() + "-" + Math.random().toString(36).slice(2) + "-" + meta.filename;
      const saveTo = join(imagesDir, filename);
      file.pipe(fs.createWriteStream(saveTo));
      file.on('end', () => {
        console.log(`Saved file: ${info.filename}`);
      });
      info.filename = filename;
    });
    bb.on('finish', () => {
      let server = data.servers.find(s => s.server === info.server);
      if (!server) {
        server = {
          server: info.server,
          slug: info.server.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
          images: [],
        }
        data.servers.push(server);
      }

      server.images.push({
        description: info.description,
        filename: info.filename,
      });
      regenerateStaticFiles();
      save();
      res.statusCode = 303;
      res.setHeader('Location', `/#${server.slug}`);
      res.end();
    });

    req.pipe(bb);
  }
});

regenerateStaticFiles();

server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});

