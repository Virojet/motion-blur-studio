from pathlib import Path
from PIL import Image, ImageDraw

output = Path(__file__).resolve().parents[1] / 'assets'
output.mkdir(exist_ok=True)
size = 1024
image = Image.new('RGBA', (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((24, 24, 1000, 1000), radius=236, fill='#7758ef')
for x, opacity in [(196, 70), (310, 115), (424, 180)]:
    layer = Image.new('RGBA', image.size)
    ImageDraw.Draw(layer).polygon([(x, 352), (x+138, 352), (x+38, 672), (x-100, 672)], fill=(255,255,255,opacity))
    image = Image.alpha_composite(image, layer)
draw = ImageDraw.Draw(image)
draw.polygon([(588, 280), (830, 280), (596, 744), (354, 744)], fill='white')
image.resize((256,256), Image.Resampling.LANCZOS).save(output / 'icon.png')
image.save(output / 'icon.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
