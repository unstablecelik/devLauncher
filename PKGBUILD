pkgname=devlauncher-git
pkgver=0.13.0
pkgrel=1
pkgdesc="A minimal open-source Minecraft launcher built with Electron"
arch=('x86_64')
url="https://github.com/unstablecelik/devLauncher"
license=('GPL-3.0-only')
depends=('nodejs' 'java-runtime=21')
makedepends=('git' 'npm')
source=("git+https://github.com/unstablecelik/devLauncher.git")
sha256sums=('SKIP')

build() {
  cd "$srcdir/devLauncher"
  npm install
  npm run build --if-present
}

package() {
  cd "$srcdir/devLauncher"
  install -d "$pkgdir/opt/devlauncher"
  cp -r . "$pkgdir/opt/devlauncher"

  install -d "$pkgdir/usr/bin"
  ln -s /opt/devlauncher/node_modules/.bin/electron "$pkgdir/usr/bin/devlauncher"
}
