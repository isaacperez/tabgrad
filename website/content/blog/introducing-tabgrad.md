---
title: Why I’m building Tabgrad
description: A browser should be all you need to work with AI.
author: Isaac Pérez
date: "2026-11-11"
illustration: browser
---

I started Tabgrad because I wanted to work with AI without setting up Python and its dependencies on every computer I used.

That also meant being able to open the same page on another computer, or share a link so someone else could run it on their own device.

## Why a browser?

A page can load the tools it needs and do the calculations locally. The playground downloads Tabgrad and, for Python examples, Pyodide. You don’t have to install Python or manage packages on your computer.

The work runs on the visitor’s CPU, or their GPU when the browser and device support it. You still need to host the page and its files, but there’s no separate computation server to maintain or pay for. The [compatibility page](/versions/) explains the browser and GPU requirements.

## Starting with PyTorch

PyTorch is already part of how many people work with AI. I wanted to bring that way of writing code to the browser.

Here’s a short example you can run in the playground:

```python wrap
import torch

x = torch.tensor(
    [-1.0, 2.0],
    dtype=torch.float32,
    requires_grad=True,
)

loss = (x * x).sum()
loss.backward()

print(x.grad.tolist())
# [-2.0, 4.0]
```

[Run this example in the playground](/playground/?example=first-gradient&language=python&device=cpu). Change either number and run it again. The two gradients are twice the corresponding inputs.

In the playground, `import torch` uses Tabgrad’s implementation of the supported PyTorch operations. It doesn’t load the official PyTorch package. Pyodide runs Python, and Tabgrad handles the tensors and calculations. You can also use Tabgrad directly from JavaScript.

## What works today

With **Tabgrad 0.3.0**, you can run tensor calculations and compute gradients from Python or JavaScript. The [compatibility page](/versions/) lists the supported operations and limits.

To put an example on your own site, the [Get started guide](/start/) includes complete HTML examples for JavaScript and Python, with the setup code as well as the calculation.

## What’s next

The goal is to make the browser a place where people can work with AI, using the hardware they already have. I’d like that to include opening existing models and adapting smaller ones.

Loading pretrained models and fine-tuning are not supported yet.

If you try Tabgrad, I’d like to hear what you wanted to build and what got in your way. You can [get in touch](/contact/) or [open an issue on GitHub](https://github.com/isaacperez/tabgrad/issues).
