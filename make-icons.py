from PIL import Image, ImageDraw
import math, os

BG1=(11,13,16); BG2=(22,28,36); ACCENT=(255,176,32); WHITE=(245,247,250)

def rounded(size, radius_ratio=0.22):
    img=Image.new("RGB",(size,size),BG1)
    d=ImageDraw.Draw(img)
    # vertical gradient
    for y in range(size):
        t=y/size
        c=tuple(int(BG1[i]+(BG2[i]-BG1[i])*t) for i in range(3))
        d.line([(0,y),(size,y)],fill=c)
    # mask for rounded corners
    mask=Image.new("L",(size,size),0)
    md=ImageDraw.Draw(mask)
    md.rounded_rectangle([0,0,size-1,size-1],radius=int(size*radius_ratio),fill=255)
    out=Image.new("RGB",(size,size),(0,0,0)); out.paste(img,(0,0),mask)
    return out,mask

def draw_mark(img, size):
    d=ImageDraw.Draw(img)
    cx,cy=size/2,size/2
    # silo ring (arc)
    r=size*0.30; w=max(2,int(size*0.05))
    d.arc([cx-r,cy-r,cx+r,cy+r],start=300,end=240,fill=ACCENT,width=w)
    # play triangle
    t=size*0.17
    pts=[(cx-t*0.75,cy-t),(cx-t*0.75,cy+t),(cx+t*0.95,cy)]
    d.polygon(pts,fill=WHITE)

for size,name in ((80,"icon.png"),(130,"largeIcon.png"),(400,"icon400.png")):
    img,_=rounded(size); draw_mark(img,size); img.save(os.path.join("icons",name))
    print("wrote icons/"+name, img.size)

# splash / bg 1920x1080
W,H=1920,1080
sp=Image.new("RGB",(W,H),BG1)
d=ImageDraw.Draw(sp)
for y in range(H):
    t=y/H
    c=tuple(int(BG1[i]+(BG2[i]-BG1[i])*t*0.8) for i in range(3))
    d.line([(0,y),(W,y)],fill=c)
cx,cy=W/2,H/2-40
r=170; w=14
d.arc([cx-r,cy-r,cx+r,cy+r],start=300,end=240,fill=ACCENT,width=w)
t=95
d.polygon([(cx-t*0.8,cy-t),(cx-t*0.8,cy+t),(cx+t*1.05,cy)],fill=WHITE)
font=None
for fp in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf","/System/Library/Fonts/Helvetica.ttc","/Library/Fonts/Arial Bold.ttf"):
    if os.path.exists(fp):
        try:
            from PIL import ImageFont
            font=ImageFont.truetype(fp,96); break
        except Exception: pass
if font:
    txt="SILO"
    bb=d.textbbox((0,0),txt,font=font)
    d.text(((W-(bb[2]-bb[0]))/2, cy+230), txt, font=font, fill=(230,234,240))
sp.save("icons/splash.png"); sp.save("icons/bg.png")
print("wrote icons/splash.png and icons/bg.png", sp.size)
