import { createServer } from 'http';
import fs, { cpSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { stat, writeFile } from 'fs/promises';
import { join } from 'path';
import mime from 'mime';
import busboy from 'busboy';

const __dirname = new URL('.', import.meta.url).pathname;

const outDir = process.argv[2] ?? join(__dirname, './out');
const hostname = process.argv[3] ?? '0.0.0.0';
const port = +(process.argv[4] ?? 3000);
const dev = process.env.NODE_ENV !== 'production';

console.log("Starting...");
console.log(`Output Directory: ${outDir}`);
console.log(`Hostname: ${hostname}`);
console.log(`Port: ${port}`);
console.log(`Development Mode: ${dev}`);

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
  console.log("Reloading templates...");
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

  let server = `
    <label for="server">
        Server Name:
      </label>
      <br/>
      <input type="text" name="server" list="servers" required />
        <datalist id="servers">
          ${data.servers.map(s => `<option value="${xssEscape(s.server)}">`).join('\n')}
        </datalist>
      <br/>
  `

  let form = `
    <form action="/api/save" method="POST" enctype="multipart/form-data">
      <h3>Upload Screenshot</h3>
      {{SERVER}}
      <label for="description">
        Description:
      </label>
      <br/>
      <textarea name="description" rows="4" cols="50"></textarea>
      <br/>
      <label for="screenshot" class="input">
        Select Screenshot
        <input type="file" name="screenshot" id="screenshot" style="display:none" accept="image/*" required />
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
          <form action="/api/delete" method="POST" onsubmit="return confirm('Are you sure you want to delete this image?');">
            <input type="hidden" name="filename" value="${xssEscape(image.filename)}">
            <input id="deleteBtn" type="submit" value="[delete]">
          </form>
        </div>
      `;
    }).join('\n');

    return `
      <section id="${xssEscape(server.slug)}">
        <a href="#" class="back-to-top">Back</a>
        <h2>${xssEscape(server.server)}</h2>
        <div class="images-container">
          ${imagesHtml}
        </div>
        ${form.replace('{{SERVER}}', '<input type="hidden" name="server" value="' + xssEscape(server.server) + '" />')}
      </section>
    `;
  }).join('\n');

  let serverList = data.servers.map(server => {
    return `<a href="#${xssEscape(server.slug)}"><li>${xssEscape(server.server)}</li></a>`;
  }).join('\n');

  serverList = `<ul>\n${serverList}\n</ul>`;

  if (data.servers.length === 0) {
    serverList = '<p style="text-align:center">No servers yet</p>';
  }

  let indexHtml = templates.index;
  indexHtml = indexHtml.replaceAll('{{UPLOAD}}', form.replace('{{SERVER}}', server));
  indexHtml = indexHtml.replaceAll('{{SERVER_LIST}}', serverList);
  indexHtml = indexHtml.replaceAll('{{SERVERS}}', serversHtml);

  writeFileSync((join(outDir, 'index.html')), indexHtml);
}

const server = createServer(async (req, res) => {
  if (dev) regenerateStaticFiles();

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
  } else if (req.method === 'POST' && url.pathname === '/api/delete') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      data.servers.forEach(server => {
        server.images = server.images.filter(image => {
          if (image.filename === params.get('filename')) {
            const filePath = join(imagesDir, image.filename);
            const deletedPath = join(deletedImagesDir, image.filename);
            fs.renameSync(filePath, deletedPath);
            return false;
          }
          return true;
        });
      });
      data.servers = data.servers.filter(server => server.images.length > 0);
      regenerateStaticFiles();
      save();
      res.statusCode = 303;
      res.setHeader('Location', '/');
      res.end();
    });
  } else {
    res.statusCode = 404;
    res.end('404 Not Found');
  }
});

regenerateStaticFiles();

server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});

