/**
 * Preset close-reading session for "Attention Is All You Need" (arXiv 1706.03762).
 *
 * Every page chip is quoted verbatim from the bundled page text, so clicking it
 * both jumps the reader and outlines the source sentence. LaTeX is rendered by
 * KaTeX (`$…$` inline, `$$…$$` block).
 */
import { cite } from "./cite.ts";

const md = String.raw;

export const attentionPreset = {
  itemKey: "1706.03762",
  title: "Transformer 精读：注意力如何取代循环",
  conclusion: md`- **解决什么问题**：循环模型必须一步接一步地算，训练无法在单个样本内并行，长句还会把 batch 压死。${cite(2, "This inherently sequential nature precludes parallelization within training examples, which becomes critical at longer sequence lengths, as memory constraints limit batching across examples")}
- **怎么做**：整套模型只留「多头自注意力 + 逐位置前馈」两种子层，编码与解码各堆 $N=6$ 层，外面套残差与层归一化。${cite(3, "The encoder is composed of a stack of N = 6 identical layers")}
- **结果如何**：WMT14 EN-DE 28.4 / EN-FR 41.8 BLEU，把此前所有模型（含集成）甩开 2.0 BLEU 以上。${cite(8, "the big transformer model (Transformer (big) in Table 2) outperforms the best previously reported models (including ensembles) by more than 2.0 BLEU, establishing a new state-of-the-art BLEU score of 28.4")}
- **为什么行得通**：任意两个位置之间只隔一条注意力边，路径长度从 $O(n)$ 降到 $O(1)$；句子级翻译里序列长度小于表示维度，复杂度和并行度双赢。${cite(7, "length n is smaller than the representation dimensionality d, which is most often the case with sentence representations used by state-of-the-art models in machine translations")}
- **代价与边界**：自注意力每层 $O(n^2\cdot d)$，长序列要靠邻域限制一类的稀疏化手段。${cite(7, "self-attention could be restricted to considering only a neighborhood of size r in the input sequence centered around the respective output position")} 缩放因子的推导、多头配置与训练配方都放在下面的方法拆解里。`,
  turns: [
    {
      q: "先给我一个结构化的核心创新点总结：这篇论文到底新在哪里？证据也一起给出。",
      a: md`先给结论，再给证据。所有页码芯片都可以点击——左边的 PDF 会跳页并把原文圈出来。

## 一、它换掉的是「串行计算」，不是「注意力」

注意力机制当时早已存在，但几乎总是挂在循环网络上。这篇论文的主张是彻底移除循环：${cite(2, "In this work we propose the Transformer, a model architecture eschewing recurrence and instead relying entirely on an attention mechanism to draw global dependencies between input and output")}

真正的痛点是位置与时间步绑定导致的不可并行：${cite(2, "This inherently sequential nature precludes parallelization within training examples, which becomes critical at longer sequence lengths, as memory constraints limit batching across examples")}

## 二、三项核心创新

**1）纯注意力的堆叠式编码器–解码器**
${cite(3, "The encoder is composed of a stack of N = 6 identical layers")}
每个子层外面套残差 + 层归一化，所有子层与 embedding 输出统一为 $d_{model}=512$：${cite(3, "we employ a residual connection [11] around each of the two sub-layers, followed by layer normalization")}

**2）缩放点积注意力 + 多头并行**（第 2 轮完整推导）
${cite(4, "We compute the dot products of the query with all keys, divide each by")}

**3）用位置编码替代循环带来的顺序性**
${cite(6, "we must inject some information about the relative or absolute position of the tokens in the sequence")}

## 三、复杂度对照（Table 1，p.6）

| 层类型 | 每层复杂度 | 串行操作数 | 最大路径长度 |
| --- | --- | --- | --- |
| Self-Attention | $O(n^2\cdot d)$ | $O(1)$ | $O(1)$ |
| Recurrent | $O(n\cdot d^2)$ | $O(n)$ | $O(n)$ |
| Convolutional | $O(k\cdot n\cdot d^2)$ | $O(1)$ | $O(\log_k n)$ |
| Self-Attention（受限邻域） | $O(r\cdot n\cdot d)$ | $O(1)$ | $O(n/r)$ |

判断依据是「序列长度 vs 表示维度」：句子级翻译里 $n \lesssim d$，所以自注意力在复杂度与并行度上双赢：${cite(7, "length n is smaller than the representation dimensionality d, which is most often the case with sentence representations used by state-of-the-art models in machine translations")}

## 四、结果落点

${cite(8, "the big transformer model (Transformer (big) in Table 2) outperforms the best previously reported models (including ensembles) by more than 2.0 BLEU, establishing a new state-of-the-art BLEU score of 28.4")}
基座模型也拿到 27.3 / 38.1 BLEU，训练代价 $3.3\times10^{18}$ FLOPs（Table 2，p.8）——比它击败的所有对手都便宜一个量级以上。`,
    },
    {
      q: "把 Attention 的公式逐条推导一遍，特别是为什么要除以 √dk，多头为什么不掉计算量。",
      a: md`这一轮全部落在公式上。行内公式用 $…$，独立公式用 $$…$$。

## 1. 缩放点积注意力

$$\mathrm{Attention}(Q,K,V)=\mathrm{softmax}\!\left(\frac{QK^{\top}}{\sqrt{d_k}}\right)V \tag{1}$$

算法描述（p.4）：${cite(4, "The input consists of queries and keys of dimension")} —— 先算 query 与所有 key 的点积，各自除以 $\sqrt{d_k}$，再 softmax 得到对 value 的权重。

**为什么要缩放？** 论文脚注给的是一个方差论证。设 $q,k$ 的分量相互独立、均值 0、方差 1，则

$$\mathbb{E}[q\cdot k]=0,\qquad \operatorname{Var}(q\cdot k)=\sum_{i=1}^{d_k}\operatorname{Var}(q_i k_i)=d_k ,$$

即点积的标准差是 $\sqrt{d_k}$。$d_k$ 一大，点积量级随之变大，softmax 会进入梯度极小的饱和区：${cite(4, "the dot products grow large in magnitude, pushing the softmax function into regions where it has extremely small gradients")}
除以 $\sqrt{d_k}$ 就是把方差重新归一到 1：${cite(4, "To counteract this effect, we scale the dot products by")}

顺带一个工程结论：点积比加性注意力快得多，因为可以走高度优化的矩阵乘：${cite(4, "dot-product attention is much faster and more space-efficient in practice, since it can be implemented using highly optimized matrix multiplication code")}

## 2. 多头注意力

$$\mathrm{MultiHead}(Q,K,V)=\mathrm{Concat}(\mathrm{head}_1,\dots,\mathrm{head}_h)W^{O},\qquad \mathrm{head}_i=\mathrm{Attention}(QW_i^{Q},\;KW_i^{K},\;VW_i^{V})$$

配置：${cite(5, "we employ h = 8 parallel attention layers, or heads")}，并且 $d_k=d_v=d_{model}/h=64$。

**为什么不掉计算量**：每个头只在 $1/h$ 维度上做注意力，$h$ 个头并行：${cite(5, "Due to the reduced dimension of each head, the total computational cost is similar to that of single-head attention with full dimensionality.")}
换来的收益是表示子空间的多样性：${cite(5, "Multi-head attention allows the model to jointly attend to information from different representation subspaces at different positions")}
消融里还能看到「头太多也会掉点」，见第 3 轮。

## 3. 残差子层

$$\mathrm{LayerNorm}\big(x+\mathrm{Sublayer}(x)\big)$$

${cite(3, "the output of each sub-layer is LayerNorm(x + Sublayer(x)), where Sublayer(x) is the function implemented by the sub-layer itself")}
> 与 ResNet 的 $y=F(x)+x$ 是同一思想：让「什么都不改」成为最容易到达的解。可以在 ResNet 那篇的会话里对照阅读。

## 4. 逐位置前馈网络

$$\mathrm{FFN}(x)=\max(0,\;xW_1+b_1)W_2+b_2 \tag{2}$$

两层线性变换夹一个 ReLU，跨位置共享参数、跨层不共享；也可视为 kernel size 为 1 的两次卷积。维度 $d_{model}=512\to d_{ff}=2048$：${cite(5, "The dimensionality of input and output is dmodel = 512, and the inner-layer has dimensionality")}

## 5. 正弦位置编码

$$PE_{(pos,2i)}=\sin\!\big(pos/10000^{2i/d_{model}}\big),\qquad PE_{(pos,2i+1)}=\cos\!\big(pos/10000^{2i/d_{model}}\big)$$

波长构成从 $2\pi$ 到 $10000\cdot2\pi$ 的几何级数；选它的理由是任意固定偏移 $k$ 下 $PE_{pos+k}$ 都可由 $PE_{pos}$ 线性表示，便于学习相对位置：${cite(6, "since for any fixed offset k, PEpos+k can be represented as a linear function of PEpos")}

## 6. 训练调度（warmup + 逆平方根）

$$lr=d_{model}^{-0.5}\cdot\min\big(step^{-0.5},\;step\cdot warmup^{-1.5}\big) \tag{3}$$

${cite(7, "This corresponds to increasing the learning rate linearly for the first warmup_steps training steps")}（论文取 $warmup\_steps=4000$）。优化器是 Adam，$\beta_1=0.9,\beta_2=0.98,\epsilon=10^{-9}$：${cite(7, "We used the Adam optimizer [20] with")}

## 7. 解码器为什么能保持自回归

自注意力子层里把非法连接置为 $-\infty$，配合输出 embedding 右移一位：${cite(5, "We implement this inside of scaled dot-product attention by masking out")} —— 这就是「Transformer 能并行训练、又能逐词生成」的机关。`,
    },
    {
      q: "实验和消融里有哪些必须记住的数字？训练配方、局限性也一起说。",
      a: md`## 1. 主结果（Table 2，p.8）

| 模型 | EN-DE | EN-FR | 训练代价（FLOPs） |
| --- | --- | --- | --- |
| GNMT + RL | 24.6 | 39.92 | $2.3\cdot10^{19}$ / $1.4\cdot10^{20}$ |
| ConvS2S | 25.16 | 40.46 | $9.6\cdot10^{18}$ / $1.5\cdot10^{20}$ |
| **Transformer (base)** | **27.3** | **38.1** | $3.3\cdot10^{18}$ |
| **Transformer (big)** | **28.4** | **41.8** | $2.3\cdot10^{19}$ |

训练规模是可以直接复现的关键数字：${cite(7, "We trained our models on one machine with 8 NVIDIA P100 GPUs")}，base 模型${cite(7, "We trained the base models for a total of 100,000 steps or 12 hours")}，big 模型 300,000 步 / 3.5 天：${cite(7, "The big models were trained for 300,000 steps")}

## 2. 两个常被忽略的正则化细节

- **残差 dropout** 作用在「加回子层输入之前」，并且对 embedding + 位置编码之和也做 dropout：${cite(8, "We apply dropout [33] to the output of each sub-layer, before it is added to the sub-layer input and normalized")}
- **label smoothing 0.1**：困惑度变差、但准确率与 BLEU 变好：${cite(8, "During training, we employed label smoothing of value")}

## 3. 消融（Table 3，p.9）的四条经验

- 注意力头数不是越多越好：${cite(9, "While single-head attention is 0.9 BLEU worse than the best setting, quality also drops off with too many heads")}
- 缩小 key 维度 $d_k$ 会掉质量 → 点积并不是最优的相容性函数：${cite(9, "we observe that reducing the attention key size")}
- 更大模型 + dropout 的组合最稳：${cite(9, "as expected, bigger models are better, and dropout is very helpful in avoiding over-fitting")}
- 正弦位置编码 ≈ 可学习位置 embedding：${cite(9, "we replace our sinusoidal positional encoding with learned positional embeddings")}

## 4. 泛化：不只适合翻译

论文额外做了英语成分句法分析（WSJ，4 层 / $d_{model}=1024$）：只用 40K 句 WSJ 训练集就有 91.3 F1，加入半监督语料后 92.7 F1（Table 4，p.10），只少数情况下仍优于 RNNG 一类生成式模型。这说明编码器–解码器骨架本身是可迁移的——BERT 后来只留下编码器做预训练，正是顺着这条线（可切换到 BERT 会话继续读）。

## 5. 局限（论文自陈 + 延伸讨论）

1. **二次复杂度**：$n$ 很长时 $O(n^2\cdot d)$ 与注意力矩阵的显存成为瓶颈。论文给出的缓解是把注意力限制在中心于输出位置的邻域 $r$ 内，代价是最大路径长度升到 $O(n/r)$：${cite(7, "self-attention could be restricted to considering only a neighborhood of size r in the input sequence centered around the respective output position")}
2. **对数据与正则化敏感**：base 模型也要 4.5M 句对：${cite(7, "We trained on the standard WMT 2014 English-German dataset consisting of about 4.5 million sentence pairs")}，小数据必须靠 dropout / label smoothing / warmup 撑住。
3. **延伸讨论（非原文）**：位置编码的外推能力、长文档上的稀疏/线性注意力、以及 $\sqrt{d_k}$ 之外的注意力设计（加性、余弦、旋转位置编码），都是 2017 年之后大量工作的方向；这些恰好都能在本页的公式上做增量修改。`,
    },
  ],
};
