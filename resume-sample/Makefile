.PHONY: all clean view pdf

TARGET = resume

all: pdf

pdf:
	pdflatex -interaction=nonstopmode -halt-on-error $(TARGET).tex
	pdflatex -interaction=nonstopmode -halt-on-error $(TARGET).tex

clean:
	rm -f $(TARGET).aux $(TARGET).fdb_latexmk $(TARGET).fls $(TARGET).log $(TARGET).out $(TARGET).synctex.gz

view:
	open $(TARGET).pdf
